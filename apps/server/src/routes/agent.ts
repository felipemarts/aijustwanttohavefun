import { derive, eventsSince, questView, type ActionResult, type AgentState, type Observation } from '@ajwf/engine';
import { actRequestSchema } from '@ajwf/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { errorBody, invalidParams } from '../http-errors';
import { MAX_IDEMPOTENCY_KEY_LEN } from '../idempotency';
import type { Part } from '../views';

export const EVENTS_PAGE = 50;

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');
const viewQuery = z.object({ verbose: flag, full: flag, since_cursor: flag });
const eventsQuery = z.object({ since: z.string().regex(/^\d{1,15}$/).transform(Number).optional() });

const round = (x: number, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Routes that act as the authenticated agent (`req.agent`). */
export function agentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, views } = ctx;

  /** Unseen inbox events, rendered for the agent, and the cursor that follows them. */
  function inbox(a: AgentState, lang: string) {
    const page = views.takeMessages(a.id);
    return { messages: render.messages(lang, a.lang, page.events), cursor: String(page.cursor) };
  }

  /** The parts that both `/look` and `/act` can send, in the agent's language. */
  function parts(a: AgentState, o: Observation, verbose: boolean) {
    const lang = render.lang(a.lang);
    return { lang, you: render.you(o.you, verbose), room: render.room(o.room, lang, verbose), actions: o.actions, time: o.time, quest: o.quest_hint };
  }

  app.get('/me', async (req) => {
    const a = req.agent!;
    const lang = render.lang(a.lang);
    const o = game.observe(a.id);
    const c = game.content;
    const d = derive(c, a, game.now());
    const equipment = Object.fromEntries(Object.entries(a.equip).filter(([, id]) => id));
    return {
      ok: true,
      agent: {
        name: a.name,
        class: a.cls,
        lvl: a.level,
        language: a.lang,
        claimed: a.claimed,
        ...(a.bot ? { bot: true } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.profession ? { profession: a.profession } : {}),
        look: render.look(a.appearance, a.lookHash, lang),
        ...(a.bio ? { bio: { untrusted_text: a.bio } } : {}),
      },
      you: render.you(o.you, false),
      room: a.room,
      stats: { str: d.str, int: d.int, agi: d.agi, vit: d.vit, atk: round(d.atk, 1), def: round(d.def, 1), crit: round(d.crit, 3) },
      inventory: a.inv,
      equipment,
      skills: (c.classes.get(a.cls)?.skills ?? []).map((id) => {
        const s = c.skills.get(id);
        return { id, lvl: s?.level ?? 1, mp: s?.mp ?? 0, ...(s && a.level < s.level ? { locked: true } : {}) };
      }),
      quests: Object.keys(a.quests).flatMap((id) => {
        const q = c.quests.get(id);
        return q ? [questView(a, q)] : [];
      }),
      achievements: a.achievements,
      titles: a.titles,
      ...(a.ownerNote ? { owner_note: a.ownerNote } : {}),
    };
  });

  app.get('/look', async (req) => {
    const a = req.agent!;
    const q = viewQuery.parse(req.query ?? {});
    const o = game.observe(a.id);
    const p = parts(a, o, q.verbose);
    const candidates: [Part, unknown][] = [
      ['narration', render.lookNarration(o.room, p.lang)],
      ['you', p.you],
      ['room', p.room],
    ];
    const tail: [Part, unknown][] = [
      ['actions', p.actions],
      ['time', p.time],
      ['quest', p.quest],
    ];
    const body: Record<string, unknown> = { ok: true };
    // `?since_cursor=1` leaves out the parts this agent already has; a plain /look is always complete.
    const put = ([part, value]: [Part, unknown]) => {
      if (value === undefined) return;
      if (views.changed(a.id, part, value) || !q.since_cursor) body[part] = value;
    };
    candidates.forEach(put);
    const box = inbox(a, p.lang);
    if (box.messages.length) body.messages = box.messages;
    tail.forEach(put);
    body.cursor = box.cursor;
    return body;
  });

  function actBody(a: AgentState, result: Extract<ActionResult, { ok: true }>, full: boolean, verbose: boolean): Record<string, unknown> {
    const o = game.observe(a.id);
    const p = parts(a, o, verbose);
    const body: Record<string, unknown> = { ok: true, narration: render.narration(p.lang, result.narration), you: p.you };
    views.changed(a.id, 'you', p.you);
    // The room is sent again only when it differs from what this agent last received (§13.3).
    if (views.changed(a.id, 'room', p.room) || full || result.action === 'move') body.room = p.room;
    const box = inbox(a, p.lang);
    if (box.messages.length) body.messages = box.messages;
    body.actions = p.actions;
    views.changed(a.id, 'actions', p.actions);
    if (views.changed(a.id, 'time', p.time) || full) body.time = p.time;
    if (p.quest !== undefined && (views.changed(a.id, 'quest', p.quest) || full)) body.quest = p.quest;
    if (result.data) body.data = result.data;
    body.cursor = box.cursor;
    return body;
  }

  app.post('/act', async (req, reply) => {
    const a = req.agent!;
    const now = game.now();
    const idemKey = req.headers['idempotency-key'];
    if (idemKey !== undefined) {
      if (typeof idemKey !== 'string' || !idemKey || idemKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
        return reply.code(400).send(errorBody(render.apiError(ctx.lang(req), 'BAD_REQUEST', 'idempotency_key')));
      }
      const stored = ctx.idem.get(a.id, idemKey, now);
      if (stored) return reply.header('idempotent-replayed', 'true').type('application/json; charset=utf-8').send(stored);
    }
    const q = viewQuery.parse(req.query ?? {});
    const parsed = actRequestSchema.safeParse(req.body ?? {});
    let body: unknown;
    if (!parsed.success) body = invalidParams(render, ctx.lang(req), parsed.error.issues);
    else {
      const result = game.act(a.id, parsed.data.action, parsed.data.params);
      // Rendered after the action: `set_language` changes the language of its own answer.
      body = result.ok ? actBody(a, result, q.full, q.verbose) : errorBody(render.error(render.lang(a.lang), result.error));
    }
    const json = JSON.stringify(body);
    if (typeof idemKey === 'string') ctx.idem.set(a.id, idemKey, json, now);
    return reply.type('application/json; charset=utf-8').send(json);
  });

  app.get('/events', async (req) => {
    const a = req.agent!;
    const lang = render.lang(a.lang);
    const q = eventsQuery.safeParse(req.query ?? {});
    if (!q.success) return invalidParams(render, lang, q.error.issues);
    const since = q.data.since ?? views.shown(a.id);
    const page = eventsSince(game.state, a.id, since, EVENTS_PAGE);
    views.markShown(a.id, page.cursor);
    return {
      ok: true,
      events: render.messages(lang, a.lang, page.events, true),
      cursor: String(page.cursor),
      ...(page.events.length >= EVENTS_PAGE ? { more: true } : {}),
    };
  });
}
