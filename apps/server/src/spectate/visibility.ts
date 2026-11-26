import { TEXT_EVENT_TYPES, type GameEvent, type SpectatorEvent, type Visibility } from '@ajwf/shared';

/**
 * The security boundary between the game and its audience: only `public` and `room` events may ever reach a
 * spectator (sockets, room logs, `/api/public`). `private` (rewards, damage taken) and `delayed` (whispers, party
 * and guild chat until revealed) never do. Anything unknown is refused.
 */
export function isSpectatorVisible(ev: Pick<GameEvent, 'visibility'>): boolean {
  const v: Visibility = ev.visibility;
  return v === 'public' || v === 'room';
}

type Msg = { k: string; p?: Record<string, unknown> };

function isMsg(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && typeof (x as { k?: unknown }).k === 'string';
}

const AGENT_REF = '@agent:';

export type EventLookup = {
  /** Current name of an agent id, if it is one. */
  agentName(id: string): string | undefined;
  /** True for NPC ids. */
  isNpc(id: string): boolean;
};

/**
 * Turns a visible engine event into what spectators receive. Agent-written text travels only in `text` (with
 * `lang`); everything else as the i18n key and params of `payload.m`, with `@agent:` references resolved to names
 * and the other `@kind:id` references left for the client to localize. Agent ids never leave the server.
 * The caller must have checked `isSpectatorVisible`.
 */
export function toSpectatorEvent(ev: GameEvent, look: EventLookup): SpectatorEvent {
  const out: SpectatorEvent = { id: ev.id, ts: ev.ts, type: ev.type };
  if (ev.roomId) out.room = ev.roomId;
  const actor = ev.actor ? look.agentName(ev.actor) : undefined;
  if (actor) out.actor = actor;
  if (ev.target) {
    const agent = look.agentName(ev.target);
    const mon = ev.payload.mon;
    if (agent) {
      out.target = agent;
      out.tk = 'agent';
    } else if (typeof mon === 'string') {
      // Monster instances (`m1a`) mean nothing outside the server: name the kind.
      out.target = mon;
      out.tk = 'mon';
    } else if (look.isNpc(ev.target)) {
      out.target = ev.target;
      out.tk = 'npc';
    }
  }
  if (TEXT_EVENT_TYPES.has(ev.type)) {
    const text = ev.payload.text;
    if (typeof text === 'string') out.text = text;
    if (ev.lang) out.lang = ev.lang;
  } else if (isMsg(ev.payload.m)) {
    out.k = ev.payload.m.k;
    const p = ev.payload.m.p;
    if (p) {
      const params: Record<string, string | number> = {};
      for (const [key, v] of Object.entries(p)) {
        if (typeof v === 'number') params[key] = v;
        else if (typeof v === 'string') params[key] = v.startsWith(AGENT_REF) ? (look.agentName(v.slice(AGENT_REF.length)) ?? '?') : v;
      }
      out.p = params;
    }
  }
  if (ev.drama) out.drama = ev.drama;
  return out;
}
