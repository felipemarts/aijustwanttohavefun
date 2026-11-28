/**
 * An in-process fake of the game server, as a `Fetch`. Small world, real API shapes (`public-docs/skill.md`):
 * register, look, act with idempotency keys, events, me, schema, profiles, appearance options. Tests can inject
 * inbox messages, refusals, rate limits and outages, and read every request it received.
 */
import type { Clock, Fetch } from '../ports.ts';
import type { GameMessage } from '../game/types.ts';

const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const str = (max = 40) => ({ type: 'string', minLength: 1, maxLength: max });

export const FAKE_SCHEMA_ACTIONS = [
  { name: 'attack', ap: 1, params: S({ target: str() }, ['target']) },
  { name: 'cast', ap: 1, params: S({ skill: str(64), target: str() }, ['skill']) },
  { name: 'duel_invite', ap: 0, params: S({ agent: str() }, ['agent']) },
  { name: 'emote', ap: 0, params: S({ emote: str(), target: str() }, ['emote']) },
  { name: 'flee', ap: 1, params: S({}) },
  { name: 'gather', ap: 2, params: S({ resource: str(64) }, ['resource']) },
  { name: 'inventory', ap: 0, params: S({}) },
  { name: 'move', ap: 1, params: S({ dir: str(64) }, ['dir']) },
  { name: 'quest_list', ap: 0, params: S({}) },
  { name: 'say', ap: 0, params: S({ text: str(2000) }, ['text']) },
  { name: 'set_language', ap: 0, params: S({ language: str(35) }, ['language']) },
  { name: 'steal', ap: 2, params: S({ target: str() }, ['target']) },
  { name: 'talk', ap: 0, params: S({ npc: str(64), topic: str(64) }, ['npc']) },
  { name: 'whisper', ap: 0, params: S({ to: str(), text: str(2000) }, ['to', 'text']) },
];

type Room = { id: string; name: string; flags: string[]; exits: Record<string, string>; npcs: { id: string; roles: string[] }[]; monster?: { id: string; lvl: number; hp: number }; resources?: Record<string, number> };

const ROOMS: Record<string, Room> = {
  'village.square': { id: 'village.square', name: 'Mistvale Square', flags: ['safe'], exits: { north: 'village.tavern', east: 'hills.trail' }, npcs: [{ id: 'olga', roles: ['quest', 'shop'] }] },
  'village.tavern': { id: 'village.tavern', name: 'The Tavern', flags: ['safe', 'tavern'], exits: { south: 'village.square' }, npcs: [] },
  'hills.trail': { id: 'hills.trail', name: 'Hill Trail', flags: ['lawless'], exits: { west: 'village.square' }, npcs: [], monster: { id: 'boar', lvl: 2, hp: 2 }, resources: { stone: 5 } },
};

export type FakeAgent = {
  name: string;
  cls: string;
  key: string;
  claim: string;
  lang: string;
  room: string;
  hp: number;
  ap: number;
  apAt: number;
  gold: number;
  xp: number;
  lvl: number;
  claimed: boolean;
  inbox: (GameMessage & { seq: number })[];
  shown: number;
  combat: number;
  fallenUntil: number;
  ownerNote?: string;
};

export type FakeRequest = { method: string; path: string; auth: string | null; idem: string | null; body: unknown; at: number };

export class FakeGame {
  readonly base: string;
  readonly agents = new Map<string, FakeAgent>();
  readonly requests: FakeRequest[] = [];
  /** fetch rejects (server down). */
  down = false;
  /** The next n authenticated requests get 429 with this Retry-After. */
  rateLimit = { n: 0, retryAfter: 2 };
  /** The next n requests get HTTP 500. */
  fail500 = 0;
  /** Refuse these actions with this code. */
  refuse = new Map<string, string>();
  /** Make every request hang until aborted. */
  hang = false;
  /** Issued keys and claim tokens (tests plant values that match no known key pattern). */
  keyFormat = (n: number) => `ajwf_sk_TESTKEY${n}SECRETVALUE${n}`;
  claimFormat = (n: number) => `CLAIMTOKEN${n}SECRET`;
  /** A careless server: refusal texts repeat the agent's key and claim link. */
  echoSecrets = false;
  private seq = 0;
  private idem = new Map<string, string>();
  private clock: Clock;
  private keySeq = 0;

  constructor(clock: Clock, base = 'http://game.test') {
    this.clock = clock;
    this.base = base;
  }

  /** Queues an inbox message for an agent, as if another agent or the world produced it. */
  tell(name: string, m: GameMessage): void {
    const a = this.agents.get(name);
    if (a) a.inbox.push({ ...m, seq: ++this.seq });
  }

  byKey(auth: string | null): FakeAgent | undefined {
    const key = auth?.replace(/^Bearer /, '');
    return [...this.agents.values()].find((a) => a.key === key);
  }

  readonly fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const req: FakeRequest = { method: (init.method ?? 'GET').toUpperCase(), path: url.pathname, auth: headers.get('authorization'), idem: headers.get('idempotency-key'), body, at: this.clock.now() };
    this.requests.push(req);
    if (this.down) throw new TypeError('fetch failed');
    if (this.hang) {
      await new Promise<never>((_, reject) => {
        const s = init.signal;
        if (s?.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        s?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    if (url.origin !== this.base) throw new TypeError('fetch failed');
    if (this.fail500 > 0) {
      this.fail500--;
      return json({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }, 500);
    }
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (req.auth && this.rateLimit.n > 0) {
      this.rateLimit.n--;
      return json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, 429, { 'retry-after': String(this.rateLimit.retryAfter) });
    }
    if (path === '/schema' && req.method === 'GET') return json({ ok: true, api_version: '1.1.0', skill_version: '1.3.0', actions: FAKE_SCHEMA_ACTIONS });
    if (path === '/appearance/options') return json({ ok: true, options_token: 'opt_fake', expires_in: 1800, options: { species: { elf: 'elf', orc: 'orc' }, hat: { none: 'no hat', cap: 'cap' } } });
    if (path === '/agents/register' && req.method === 'POST') return this.register(body as Record<string, unknown>);
    const prof = /^\/agents\/([^/]+)$/.exec(path);
    if (prof && req.method === 'GET') {
      const a = this.agents.get(decodeURIComponent(prof[1]!));
      return a ? json({ ok: true, agent: { name: a.name, class: a.cls, lvl: a.lvl, sprite: `/sprites/${a.name.toLowerCase()}.png`, claimed: a.claimed } }) : json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such agent.' } }, 404);
    }
    const a = this.byKey(req.auth);
    if (!a) return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Bad key.' } }, 401);
    this.regen(a);
    if (path === '/look') return json({ ok: true, narration: `${ROOMS[a.room]!.name}.`, ...this.view(a), messages: this.take(a), cursor: String(this.seq) });
    if (path === '/me') return json(this.me(a));
    if (path === '/events') {
      const since = Number(url.searchParams.get('since') ?? a.shown);
      const events = a.inbox.filter((m) => m.seq > since).map(({ seq, ...m }) => ({ ...m, id: String(seq) }));
      a.shown = Math.max(a.shown, this.seq);
      return json({ ok: true, events, cursor: String(this.seq) });
    }
    if (path === '/act' && req.method === 'POST') {
      if (req.idem && this.idem.has(`${a.name}:${req.idem}`)) return new Response(this.idem.get(`${a.name}:${req.idem}`)!, { status: 200, headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' } });
      const out = this.act(a, body as { action: string; params: Record<string, unknown> });
      const text = JSON.stringify(out);
      if (req.idem && out.ok) this.idem.set(`${a.name}:${req.idem}`, text);
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  };

  private register(b: Record<string, unknown>): Response {
    const name = String(b.name ?? '');
    if (this.agents.has(name)) return json({ ok: false, error: { code: 'NAME_TAKEN', message: `The name ${name} is taken.`, hint: 'Pick another name.' } });
    const n = ++this.keySeq;
    const a: FakeAgent = {
      name,
      cls: String(b.class),
      key: this.keyFormat(n),
      claim: `${this.base}/claim/${this.claimFormat(n)}`,
      lang: String(b.language ?? 'en'),
      room: 'village.square',
      hp: 80,
      ap: 240,
      apAt: this.clock.now(),
      gold: 25,
      xp: 0,
      lvl: 1,
      claimed: false,
      inbox: [],
      shown: this.seq,
      combat: 0,
      fallenUntil: 0,
    };
    this.agents.set(name, a);
    this.tell(name, { kind: 'arrival', text: `${name} arrives in Mistvale.` });
    return json({ ok: true, agent: { name, class: a.cls, level: 1, language: a.lang, appearance_text: 'an elf' }, api_key: a.key, claim_url: a.claim, next_steps: 'Save your api_key.' });
  }

  /** Adds another player's agent standing in a room (for PvP checks). */
  addOther(name: string, room: string): FakeAgent {
    const a: FakeAgent = { name, cls: 'rogue', key: `ajwf_sk_OTHER${name}`, claim: '', lang: 'en', room, hp: 80, ap: 240, apAt: this.clock.now(), gold: 99, xp: 0, lvl: 9, claimed: true, inbox: [], shown: 0, combat: 0, fallenUntil: 0 };
    this.agents.set(name, a);
    return a;
  }

  private regen(a: FakeAgent): void {
    const gained = Math.floor((this.clock.now() - a.apAt) / 120_000);
    if (gained > 0) {
      a.ap = Math.min(240, a.ap + gained);
      a.apAt += gained * 120_000;
    }
  }

  private take(a: FakeAgent): GameMessage[] | undefined {
    const out = a.inbox.filter((m) => m.seq > a.shown).slice(0, 10);
    if (out.length) a.shown = out[out.length - 1]!.seq;
    return out.length ? out.map(({ seq: _s, ...m }) => m) : undefined;
  }

  private you(a: FakeAgent): Record<string, unknown> {
    const r = ROOMS[a.room]!;
    return {
      lvl: a.lvl,
      hp: [a.hp, 80],
      mp: [40, 40],
      ap: [a.ap, 240],
      gold: a.gold,
      xp: [a.xp, 100],
      bag: [2, 30],
      ...(a.combat && r.monster ? { in_combat: r.monster.id } : {}),
      ...(a.fallenUntil > this.clock.now() ? { fallen: Math.ceil((a.fallenUntil - this.clock.now()) / 1000) } : {}),
    };
  }

  private view(a: FakeAgent): Record<string, unknown> {
    const r = ROOMS[a.room]!;
    const others = [...this.agents.values()].filter((o) => o !== a && o.room === a.room).map((o) => ({ name: o.name, class: o.cls, lvl: o.lvl }));
    const actions = ['move', 'say', 'whisper', 'emote', 'inventory', 'quest_list', 'set_language'];
    if (r.npcs.length) actions.push('talk');
    if (r.monster) actions.push('attack', 'cast', 'flee');
    if (r.resources) actions.push('gather');
    if (others.length) actions.push('duel_invite');
    if (r.flags.includes('lawless') && others.length) actions.push('steal');
    return {
      you: this.you(a),
      room: { id: r.id, name: r.name, flags: r.flags, exits: r.exits, ...(others.length ? { agents: others } : {}), ...(r.npcs.length ? { npcs: r.npcs } : {}), ...(r.monster ? { monsters: [{ id: r.monster.id, n: 1, lvl: r.monster.lvl }] } : {}), ...(r.resources ? { resources: r.resources } : {}) },
      actions,
      time: 'day',
    };
  }

  private me(a: FakeAgent): Record<string, unknown> {
    return {
      ok: true,
      agent: { name: a.name, class: a.cls, lvl: a.lvl, language: a.lang, claimed: a.claimed, look: 'an elf' },
      you: this.you(a),
      room: a.room,
      stats: { str: 2, int: 12 },
      inventory: { bread: 3 },
      equipment: { weapon: 'apprentice_staff' },
      skills: [{ id: 'firebolt', lvl: 1, mp: 6 }],
      quests: [{ id: 't01_arrival', kind: 'tutorial', giver: 'olga', steps: [{ do: 'talk', target: 'olga', have: 0, need: 1 }], ready: false }],
      achievements: { first_steps: 1 },
      titles: [],
      ...(a.ownerNote ? { owner_note: a.ownerNote } : {}),
    };
  }

  private act(a: FakeAgent, b: { action: string; params: Record<string, unknown> }): Record<string, unknown> {
    const { action, params = {} } = b ?? { action: '', params: {} };
    const refusal = this.refuse.get(action);
    const echo = this.echoSecrets ? ` (key ${a.key}, claim ${a.claim})` : '';
    const fail = (code: string, message: string, hint?: string) => ({ ok: false, error: { code, message: message + echo, ...(hint ? { hint } : {}) } });
    if (refusal) return fail(refusal, `Refused: ${refusal}.`, 'Try something else.');
    const r = ROOMS[a.room]!;
    const cost = action === 'move' || action === 'attack' || action === 'cast' || action === 'flee' ? 1 : action === 'gather' || action === 'steal' ? 2 : 0;
    if (a.ap < cost) return fail('NOT_ENOUGH_AP', 'You are too tired.', 'Wait for AP to refill.');
    a.ap -= cost;
    let narration: string;
    let room = false;
    switch (action) {
      case 'move': {
        const to = r.exits[String(params.dir)];
        if (!to) return fail('INVALID_PARAMS', 'No exit that way.');
        a.room = to;
        a.combat = 0;
        room = true;
        narration = `You walk ${String(params.dir)} to ${ROOMS[to]!.name}.`;
        break;
      }
      case 'attack':
      case 'cast': {
        const target = String(params.target ?? r.monster?.id ?? '');
        const victim = this.agents.get(target);
        if (victim && victim.room === a.room) {
          narration = `You attack ${victim.name}!`;
          victim.hp -= 10;
          break;
        }
        if (!r.monster || target !== r.monster.id) return fail('TARGET_NOT_FOUND', 'Nothing like that here.');
        a.combat++;
        if (a.combat >= r.monster.hp) {
          a.combat = 0;
          a.xp += 60;
          a.gold += 3;
          narration = 'You slay the boar. +60 XP, +3 gold.';
          if (a.xp >= 100) {
            a.xp -= 100;
            a.lvl++;
            narration += ` You reach level ${a.lvl}!`;
          }
        } else narration = 'You hit the boar. It hits back.';
        a.hp -= 5;
        break;
      }
      case 'steal': {
        const victim = this.agents.get(String(params.target));
        if (!victim) return fail('TARGET_NOT_FOUND', 'Nobody like that here.');
        a.gold += 5;
        victim.gold -= 5;
        narration = `You steal from ${victim.name}.`;
        break;
      }
      case 'say':
        if (!a.claimed) return fail('UNCLAIMED_LIMIT', 'You cannot use say until your human claims you.', 'Send your claim_url to your human.');
        narration = 'You speak.';
        break;
      case 'talk':
        narration = `Olga smiles at you.${echo}`;
        break;
      default:
        narration = `You ${action}.`;
    }
    return { ok: true, narration, you: this.you(a), ...(room ? { room: (this.view(a) as { room: unknown }).room } : {}), messages: this.take(a), actions: (this.view(a) as { actions: string[] }).actions, cursor: String(this.seq) };
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
