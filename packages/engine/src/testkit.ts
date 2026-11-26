/**
 * Test helpers: a world built from the real content, agents with deterministic looks and a fake clock.
 * Used by the engine's own tests only; it is not exported from the package.
 */
import { randomAppearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import { loadContent } from '@ajwf/content/node';
import { createRng, hashString, type ClassId, type GameEvent, type Rng } from '@ajwf/shared';
import { derive, touch } from './agent';
import { applyAction } from './apply';
import { registerAgent } from './register';
import { newRun } from './run';
import { tick } from './tick';
import type { ActionCtx, AgentState, ApplyResult, MonsterInst, WorldState } from './types';
import { createWorld, relocate } from './world';

/** Midnight UTC: the start of a game day (dawn), and of a real day. */
export const T0 = Date.UTC(2026, 0, 5);
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

export type AddOpts = { claimed?: boolean; room?: string; level?: number; lang?: string };

export type Kit = {
  s: WorldState;
  c: Content;
  rng: Rng;
  now: number;
  /** Milliseconds the clock moves before each `act`. */
  step: number;
  ctx(): ActionCtx;
  /** Moves the clock forward and runs the timers that became due. Returns their events. */
  advance(ms: number): GameEvent[];
  /** Registers an agent (claimed by default) in the village square, or in `room`. */
  add(name: string, cls: ClassId, opts?: AddOpts): AgentState;
  /** Advances the clock by `step`, runs due timers, then applies the action. */
  act(a: AgentState, action: string, params?: Record<string, unknown>): ApplyResult;
  /** Like `act`, but throws when the action fails. */
  ok(a: AgentState, action: string, params?: Record<string, unknown>): ApplyResult;
  /** Like `act`, but throws unless the action fails; returns the error code. */
  err(a: AgentState, action: string, params?: Record<string, unknown>): string;
  /** Teleports an agent (test setup only). */
  place(a: AgentState, room: string): void;
  /** Sets the level and heals fully (test setup only). */
  setLevel(a: AgentState, level: number): void;
  monsters(room: string): MonsterInst[];
  maxHp(a: AgentState): number;
  /** Brings lazy regeneration up to date without acting. */
  refresh(a: AgentState): void;
};

/** Narration keys of a result (empty for errors). */
export function keys(r: ApplyResult): string[] {
  return r.result.ok ? r.result.narration.map((m) => m.k) : [];
}

/** The narration fragment with this key, if any. */
export function narr(r: ApplyResult, key: string): Record<string, string | number> | undefined {
  if (!r.result.ok) return undefined;
  const m = r.result.narration.find((x) => x.k === key);
  return m ? (m.p ?? {}) : undefined;
}

/** The structured extras of a successful result (empty for errors). */
export function dataOf(r: ApplyResult): Record<string, unknown> {
  return r.result.ok ? (r.result.data ?? {}) : {};
}

export function errCode(r: ApplyResult): string | null {
  return r.result.ok ? null : r.result.error.code;
}

export function errKey(r: ApplyResult): string | null {
  return r.result.ok ? null : r.result.error.msg.k;
}

/** A deterministic rng whose `next` returns the given values in a loop (for forcing crits and misses). */
export function scriptedRng(values: number[]): Rng {
  let i = 0;
  const base = createRng(1);
  const next = () => values[i++ % values.length]!;
  return {
    ...base,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)]!,
    chance: (p) => next() < p,
    range: (min, max) => min + next() * (max - min),
  };
}

export function makeKit(seed = 1, start = T0): Kit {
  const c = loadContent();
  const s = createWorld(c, start);
  const kit: Kit = {
    s,
    c,
    rng: createRng(seed),
    now: start,
    step: SEC,
    ctx: () => ({ now: kit.now, rng: kit.rng }),
    advance(ms) {
      kit.now += ms;
      return tick(s, kit.ctx());
    },
    add(name, cls, opts = {}) {
      const look = randomAppearance(createRng(parseInt(hashString(name).slice(0, 8), 16)));
      const res = registerAgent(s, { name, cls, lang: opts.lang ?? 'en', appearance: look, claimed: opts.claimed ?? true }, kit.ctx());
      if (!res.ok) throw new Error(`register ${name}: ${res.error.code} ${res.error.msg.k}`);
      if (opts.room) kit.place(res.agent, opts.room);
      if (opts.level) kit.setLevel(res.agent, opts.level);
      return res.agent;
    },
    act(a, action, params) {
      kit.advance(kit.step);
      return applyAction(s, { agentId: a.id, action, params }, kit.ctx());
    },
    ok(a, action, params) {
      const r = kit.act(a, action, params);
      if (!r.result.ok) throw new Error(`${action} ${JSON.stringify(params ?? {})} failed: ${r.result.error.code} ${r.result.error.msg.k}`);
      return r;
    },
    err(a, action, params) {
      const r = kit.act(a, action, params);
      if (r.result.ok) throw new Error(`${action} ${JSON.stringify(params ?? {})} unexpectedly succeeded`);
      return r.result.error.code;
    },
    place(a, room) {
      relocate(s, a, room, kit.now);
    },
    setLevel(a, level) {
      a.level = level;
      a.xp = 0;
      const d = derive(c, a, kit.now);
      a.hp = d.maxHp;
      a.mp = d.maxMp;
    },
    monsters: (room) => s.rooms.get(room)!.monsters,
    maxHp: (a) => derive(c, a, kit.now).maxHp,
    refresh(a) {
      touch(newRun(s, kit.now, kit.rng, a), a);
    },
  };
  return kit;
}

/** Total gold carried by every agent. */
export function totalGold(s: WorldState): number {
  let g = 0;
  for (const a of s.agents.values()) g += a.gold;
  return g;
}

/**
 * All gold and items in the world, wherever they sit: bags, equipment, the ground, market escrow, guild treasuries
 * and vaults, the village treasury. Transfers between holders must leave it unchanged.
 */
export function worldWealth(s: WorldState): { gold: number; items: Record<string, number> } {
  const items: Record<string, number> = {};
  const add = (id: string, qty: number) => (items[id] = (items[id] ?? 0) + qty);
  let gold = s.village.treasury;
  for (const a of s.agents.values()) {
    gold += a.gold;
    for (const [id, qty] of Object.entries(a.inv)) add(id, qty);
    for (const id of Object.values(a.equip)) if (id) add(id, 1);
  }
  for (const r of s.rooms.values()) for (const [id, qty] of Object.entries(r.ground)) add(id, qty);
  for (const o of Object.values(s.market.orders)) add(o.item, o.qty);
  for (const g of s.guilds.values()) {
    gold += g.treasury;
    for (const [id, qty] of Object.entries(g.vault)) add(id, qty);
  }
  return { gold, items };
}

/** Puts the agents in `room` and parties them up through the actions (the first one leads). */
export function partyUp(k: Kit, room: string, ...members: AgentState[]): AgentState[] {
  const [leader, ...rest] = members;
  for (const m of members) k.place(m, room);
  for (const m of rest) {
    k.ok(leader!, 'party_invite', { agent: m.name });
    k.ok(m, 'party_accept', { agent: leader!.name });
  }
  return members;
}

/** The error message key and hint key of a refused action, for checking both at once. */
export function errKeys(r: ApplyResult): { code: string; msg: string; hint?: string; p?: Record<string, string | number> } | null {
  if (r.result.ok) return null;
  const e = r.result.error;
  return { code: e.code, msg: e.msg.k, ...(e.hint ? { hint: e.hint.k } : {}), ...(e.msg.p ? { p: e.msg.p } : {}) };
}
