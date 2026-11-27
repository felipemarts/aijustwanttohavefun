import type { Content } from '@ajwf/content';
import type { ErrorCode, GameEvent, Msg, MsgParams, Rng, Visibility } from '@ajwf/shared';
import type { AgentState, Inbox, Ring, WorldState } from './types';
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

/**
 * Events addressed to one agent that it has to act on or answer: kept, for the agent they are about (actor or
 * target), in the inbox's priority ring, which room events (emotes, chatter, fights) never enter. Inside that ring,
 * one counterpart holds at most `BALANCE.inbox.prioritySender` events: a single agent cycling offers and
 * cancellations replaces its own older events, never someone else's.
 */
export const PRIORITY_EVENTS: ReadonlySet<string> = new Set([
  'whisper', 'trade_offer', 'trade_cancel', 'trade', 'friend_request', 'friend', 'party_invite', 'guild_invite', 'duel_invite',
  'market_sold', 'give', 'bounty_placed', 'scam_reported', 'quest_ready', 'loot_share',
]);

function ringPush(box: Ring, cap: number, ev: GameEvent): void {
  if (box.size < cap) {
    box.buf[(box.head + box.size) % cap] = ev;
    box.size++;
  } else {
    box.buf[box.head] = ev;
    box.head = (box.head + 1) % cap;
  }
}

function ringItems(box: Ring, cap: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < box.size; i++) {
    const ev = box.buf[(box.head + i) % cap];
    if (ev) out.push(ev);
  }
  return out;
}

const emptyRing = (): Ring => ({ buf: [], head: 0, size: 0 });

/** Per-agent ring buffers of the latest events that concern the agent (`GET /events`). */
export function inboxPush(s: WorldState, agentId: string, ev: GameEvent): void {
  let box = s.inboxes.get(agentId);
  if (!box) {
    box = { ...emptyRing(), pri: emptyRing() };
    s.inboxes.set(agentId, box);
  }
  if (PRIORITY_EVENTS.has(ev.type) && (ev.target === agentId || ev.actor === agentId)) priorityPush(box, agentId, ev);
  else ringPush(box, BALANCE.inbox.size, ev);
}

/** The other side of an addressed event, seen from its recipient. */
const counterpart = (ev: GameEvent, agentId: string): string => (ev.actor === agentId ? (ev.target ?? '') : (ev.actor ?? ''));

function priorityPush(box: Inbox, agentId: string, ev: GameEvent): void {
  const I = BALANCE.inbox;
  const who = counterpart(ev, agentId);
  const items = ringItems(box.pri, I.prioritySize);
  const mine = items.filter((x) => counterpart(x, agentId) === who);
  if (mine.length >= I.prioritySender) {
    // Bounded by the ring's size: rebuild it without this counterpart's oldest event.
    const kept = items.filter((x) => x !== mine[0]);
    kept.push(ev);
    box.pri = { buf: kept, head: 0, size: kept.length };
    return;
  }
  ringPush(box.pri, I.prioritySize, ev);
}

/** Drops the events matching `drop` from an agent's inbox, keeping the order of the rest. */
export function inboxRemove(s: WorldState, agentId: string, drop: (ev: GameEvent) => boolean): void {
  const box = s.inboxes.get(agentId);
  if (!box) return;
  const keep = (ring: Ring, cap: number): Ring => {
    const kept = ringItems(ring, cap).filter((ev) => !drop(ev));
    return { buf: kept, head: 0, size: kept.length };
  };
  s.inboxes.set(agentId, { ...keep(box, BALANCE.inbox.size), pri: keep(box.pri, BALANCE.inbox.prioritySize) });
}

/** Events in the inbox with id greater than `cursor`, oldest first (both rings merged by id). */
export function inboxSince(s: WorldState, agentId: string, cursor: number, limit = 50): GameEvent[] {
  const box: Inbox | undefined = s.inboxes.get(agentId);
  if (!box) return [];
  const a = ringItems(box, BALANCE.inbox.size).filter((ev) => Number(ev.id) > cursor);
  const b = ringItems(box.pri, BALANCE.inbox.prioritySize).filter((ev) => Number(ev.id) > cursor);
  const out: GameEvent[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && Number(a[i]!.id) < Number(b[j]!.id))) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

export function markAgent(s: WorldState, a: AgentState): void {
  s.dirty.add(`agent:${a.id}`);
}

export function markRoom(s: WorldState, roomId: string): void {
  s.dirty.add(`room:${roomId}`);
}
