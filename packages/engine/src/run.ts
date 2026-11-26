import type { Content } from '@ajwf/content';
import type { ErrorCode, GameEvent, Msg, MsgParams, Rng, Visibility } from '@ajwf/shared';
import type { AgentState, Inbox, WorldState } from './types';
import { BALANCE } from './balance';

/**
 * One pass through the engine: a single action or a single tick. Collects the events it produced and, when an
 * agent is acting, the second-person narration for that agent.
 */
export type Run = {
  s: WorldState;
  c: Content;
  now: number;
  rng: Rng;
  events: GameEvent[];
  /** The agent whose action is being applied; null during ticks. */
  actor: AgentState | null;
  /** Narration for the actor, as i18n keys. */
  narr: Msg[];
  /** Structured extras returned with the action result. */
  data: Record<string, unknown>;
};

export function newRun(s: WorldState, now: number, rng: Rng, actor: AgentState | null = null): Run {
  return { s, c: s.content, now, rng, events: [], actor, narr: [], data: {} };
}

/** Builds a narration fragment. Keys passed here are checked against the English catalog by the i18n tests. */
export function msg(k: string, p?: MsgParams): Msg {
  return p ? { k, p } : { k };
}

/** Narrates to the acting agent (no-op for ticks). */
export function tell(run: Run, k: string, p?: MsgParams): void {
  run.narr.push(msg(k, p));
}

export class GameError extends Error {
  constructor(
    public code: ErrorCode,
    public slug: string,
    public params?: MsgParams,
  ) {
    super(`${code}:${slug}`);
  }
}

/**
 * Aborts the action with an error. The message is `err.<slug>` and the optional hint `hint.<slug>`.
 * Handlers must call this before mutating anything.
 */
export function fail(code: ErrorCode, slug: string, params?: MsgParams): never {
  throw new GameError(code, slug, params);
}

export type EmitOpts = {
  room?: string;
  actor?: string;
  target?: string;
  vis?: Visibility;
  drama?: number;
  revealAt?: number;
  lang?: string;
  /** Who gets the event in their inbox: everyone in the room, a list of agent ids, or nobody (default). */
  to?: 'room' | readonly string[] | 'none';
  /** Third-person description, as an i18n key. */
  m?: Msg;
  data?: Record<string, unknown>;
};

export function emit(run: Run, type: string, o: EmitOpts = {}): GameEvent {
  const s = run.s;
  const ev: GameEvent = {
    id: String(++s.meta.eventSeq),
    ts: run.now,
    type,
    visibility: o.vis ?? 'room',
    payload: o.m ? { m: o.m, ...o.data } : { ...o.data },
  };
  if (o.room !== undefined) ev.roomId = o.room;
  if (o.actor !== undefined) ev.actor = o.actor;
  if (o.target !== undefined) ev.target = o.target;
  if (o.drama !== undefined) ev.drama = o.drama;
  if (o.revealAt !== undefined) ev.revealAt = o.revealAt;
  if (o.lang !== undefined) ev.lang = o.lang;
  run.events.push(ev);

  const skip = run.actor?.id;
  if (o.to === 'room' && o.room !== undefined) {
    const present = s.roomAgents.get(o.room);
    if (present) for (const id of present) if (id !== skip) inboxPush(s, id, ev);
  } else if (Array.isArray(o.to)) {
    for (const id of o.to as readonly string[]) if (id !== skip) inboxPush(s, id, ev);
  }
  return ev;
}

/** Per-agent ring buffer of the latest events that concern the agent (`GET /events`). */
export function inboxPush(s: WorldState, agentId: string, ev: GameEvent): void {
  let box = s.inboxes.get(agentId);
  if (!box) {
    box = { buf: [], head: 0, size: 0 };
    s.inboxes.set(agentId, box);
  }
  const cap = BALANCE.inbox.size;
  if (box.size < cap) {
    box.buf[(box.head + box.size) % cap] = ev;
    box.size++;
  } else {
    box.buf[box.head] = ev;
    box.head = (box.head + 1) % cap;
  }
}

/** Events in the inbox with id greater than `cursor`, oldest first. */
export function inboxSince(s: WorldState, agentId: string, cursor: number, limit = 50): GameEvent[] {
  const box: Inbox | undefined = s.inboxes.get(agentId);
  if (!box) return [];
  const out: GameEvent[] = [];
  const cap = BALANCE.inbox.size;
  for (let i = 0; i < box.size && out.length < limit; i++) {
    const ev = box.buf[(box.head + i) % cap];
    if (ev && Number(ev.id) > cursor) out.push(ev);
  }
  return out;
}

export function markAgent(s: WorldState, a: AgentState): void {
  s.dirty.add(`agent:${a.id}`);
}

export function markRoom(s: WorldState, roomId: string): void {
  s.dirty.add(`room:${roomId}`);
}
