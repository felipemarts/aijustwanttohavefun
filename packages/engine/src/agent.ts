import type { Content, Item } from '@ajwf/content';
import { hasOwnKey, own, ref } from '@ajwf/shared';
import { BALANCE, xpToNext } from './balance';
import { assertAmount, covers, stockAdd, stockTake } from './ledger';
import { emit, markAgent, msg, tell, type Run } from './run';
import type { AgentState, Buff, EquipSlot, Stack } from './types';
import { applyLibrary } from './unlocks';
import { relocate } from './world';

export type Derived = {
  str: number;
  int: number;
  agi: number;
  vit: number;
  atk: number;
  def: number;
  maxHp: number;
  maxMp: number;
  crit: number;
};

const STAT_KEYS = ['str', 'int', 'agi', 'vit'] as const;

/** Stats after class growth, equipment and active buffs. */
export function derive(c: Content, a: AgentState, now: number): Derived {
  const cls = c.classes.get(a.cls)!;
  const out = { str: 0, int: 0, agi: 0, vit: 0 };
  for (const k of STAT_KEYS) out[k] = cls.base[k] + cls.per_level[k] * (a.level - 1);
  let atk = 0;
  let def = 0;
  let mpMult = 1;
  for (const slot of ['weapon', 'armor', 'trinket'] as const) {
    const id = a.equip[slot];
    const st = id ? c.items.get(id)?.stats : undefined;
    if (!st) continue;
    atk += st.atk ?? 0;
    def += st.def ?? 0;
    for (const k of STAT_KEYS) out[k] += st[k] ?? 0;
  }
  for (const k of STAT_KEYS) out[k] = Math.floor(out[k]);
  for (const b of a.buffs) {
    if (b.until <= now) continue;
    if (b.stat === 'atk') atk += b.value;
    else if (b.stat === 'def') def += b.value;
    else if (b.stat === 'max_mp') mpMult += b.value;
  }
  const B = BALANCE;
  return {
    ...out,
    atk: atk + out[cls.primary],
    def: def + out.vit * B.combat.vitDef,
    maxHp: Math.floor(B.hp.base + out.vit * B.hp.perVit + a.level * B.hp.perLevel),
    maxMp: Math.floor((B.mp.base + out.int * B.mp.perInt) * mpMult),
    crit: Math.min(B.combat.critMax, B.combat.critBase + out.agi * B.combat.critPerAgi),
  };
}

export function buffValue(a: AgentState, stat: Buff['stat'], now: number): number {
  let v = 0;
  for (const b of a.buffs) if (b.stat === stat && b.until > now) v += b.value;
  return v;
}

/** Adds a buff, replacing an older one with the same id. */
export function addBuff(a: AgentState, b: Buff): void {
  a.buffs = a.buffs.filter((x) => x.id !== b.id);
  a.buffs.push(b);
}

/**
 * Brings an agent up to date with the clock: AP, HP and MP regeneration, expired buffs, combat that timed out
 * and the walk back from death. Must run before reading or changing any of those.
 * `wake: false` skips the walk back (used by read-only observation, which must not emit events).
 */
export function touch(run: Run, a: AgentState, wake = true): void {
  const now = run.now;
  const B = BALANCE;

  if (a.ap >= B.ap.max) a.apAt = now;
  else {
    const gained = Math.floor((now - a.apAt) / B.ap.regenMs);
    if (gained > 0) {
      a.ap = Math.min(B.ap.max, a.ap + gained);
      a.apAt = a.ap >= B.ap.max ? now : a.apAt + gained * B.ap.regenMs;
    }
  }

  if (a.buffs.length && a.buffs.some((b) => b.until <= now)) a.buffs = a.buffs.filter((b) => b.until > now);
  applyLibrary(run.s, a);
  // Regeneration only counts from the moment the fight ended, not from the last update.
  let regenFrom = a.regenAt;
  if (a.combat) {
    const mon = a.combat.mon;
    if (a.combat.until <= now) {
      regenFrom = Math.max(regenFrom, a.combat.until);
      a.combat = null;
    } else if (!run.s.rooms.get(a.room)?.monsters.some((m) => m.uid === mon)) {
      // The monster died, reset or left: nothing is fighting the agent any more.
      a.combat = null;
    }
  }
  if (wake && a.fallen && a.fallen.until <= now) wakeAtTemple(run, a);

  const dt = now - regenFrom;
  if (now > a.regenAt) {
    if (dt > 0 && !a.fallen && !a.combat) {
      const d = derive(run.c, a, now);
      a.hp = regenerated(a.hp, d.maxHp, B.regen.hpPerMin, a, now, dt);
      a.mp = regenerated(a.mp, d.maxMp, B.regen.mpPerMin, a, now, dt);
    }
    a.regenAt = now;
  }
}

/** A pool (HP or MP) after `dt` ms of regeneration, capped at its maximum. */
function regenerated(cur: number, max: number, perMin: number, a: AgentState, now: number, dt: number): number {
  if (!(cur < max)) return cur;
  return Math.min(max, cur + (max * perMin * (1 + buffValue(a, 'regen', now)) * dt) / 60_000);
}

/**
 * The HP `touch` would bring an agent to right now, without changing anything: for checks made on another agent
 * before an action decides to go ahead (a refused action must leave the world as it was).
 */
export function hpNow(run: Run, a: AgentState): number {
  const now = run.now;
  if (a.fallen || !(now > a.regenAt)) return a.hp;
  let regenFrom = a.regenAt;
  if (a.combat) {
    const mon = a.combat.mon;
    if (a.combat.until <= now) regenFrom = Math.max(regenFrom, a.combat.until);
    else if (run.s.rooms.get(a.room)?.monsters.some((m) => m.uid === mon)) return a.hp;
  }
  const dt = now - regenFrom;
  return dt > 0 ? regenerated(a.hp, derive(run.c, a, now).maxHp, BALANCE.regen.hpPerMin, a, now, dt) : a.hp;
}

/** HP as shown to players: whole numbers, never 0 while standing. */
export function shownHp(a: AgentState): number {
  return a.fallen ? 0 : Math.max(1, Math.ceil(a.hp));
}

// ── Inventory ────────────────────────────────────────────────────────────────

const STACKABLE_TYPES = new Set(['consumable', 'food', 'material', 'quest', 'dye']);

export function isStackable(item: Item): boolean {
  return item.stackable ?? STACKABLE_TYPES.has(item.type);
}

export function slotsUsed(c: Content, inv: Readonly<Record<string, number>> | ReadonlyMap<string, number>): number {
  let n = 0;
  for (const [id, qty] of inv instanceof Map ? inv : Object.entries(inv)) {
    if (!(qty > 0)) continue;
    const item = c.items.get(id);
    n += item && !isStackable(item) ? qty : 1;
  }
  return n;
}

/** Inventory slots with this bag equipped (null: none). */
export function bagCapacity(c: Content, bag: string | null): number {
  const item = bag ? c.items.get(bag) : undefined;
  return BALANCE.inventory.slots + (item?.bag_slots ?? 0);
}

export function capacity(c: Content, a: AgentState): number {
  return bagCapacity(c, a.equip.bag);
}

/** Would the inventory still fit after removing `out` and adding `add` (with `cap` slots, by default the current ones)? */
export function canFit(c: Content, a: AgentState, add: readonly Stack[], out: readonly Stack[] = [], cap = capacity(c, a)): boolean {
  const inv = new Map(Object.entries(a.inv));
  for (const s of out) inv.set(s.item, (inv.get(s.item) ?? 0) - s.qty);
  for (const s of add) inv.set(s.item, (inv.get(s.item) ?? 0) + s.qty);
  return slotsUsed(c, inv) <= cap;
}

export function count(a: AgentState, item: string): number {
  return own(a.inv, item) ?? 0;
}

/** Whether the agent carries all of these (NaN or negative quantities answer no). */
export function hasAll(a: AgentState, stacks: readonly Stack[]): boolean {
  return stacks.every((s) => covers(count(a, s.item), s.qty));
}

/** Puts items in the bags (no room check: see `canFit`). Throws before changing anything on a bad id or quantity. */
export function addItem(a: AgentState, item: string, qty: number): void {
  stockAdd(a.inv, item, qty, `inventory of ${a.id}`);
}

/** Takes items out of the bags; the agent must carry them. Throws before changing anything otherwise. */
export function removeItem(a: AgentState, item: string, qty: number): void {
  stockTake(a.inv, item, qty, `inventory of ${a.id}`);
}

/** Gives an item, or leaves it on the ground when the bags are full. Returns false when it fell. */
export function giveOrDrop(run: Run, a: AgentState, item: string, qty: number): boolean {
  if (canFit(run.c, a, [{ item, qty }])) {
    addItem(a, item, qty);
    return true;
  }
  stockAdd(run.s.rooms.get(a.room)!.ground, item, qty, `ground of ${a.room}`);
  run.s.dirty.add(`room:${a.room}`);
  return false;
}

export function equipped(a: AgentState, slot: EquipSlot): string | null {
  return a.equip[slot];
}

// ── Stats, achievements, titles ──────────────────────────────────────────────

function checkAchievements(run: Run, a: AgentState, stat: string): void {
  const list = run.c.achievementsByStat.get(stat);
  if (!list) return;
  const value = own(a.stats, stat) ?? 0;
  for (const ach of list) {
    if (!(value >= ach.gte) || hasOwnKey(a.achievements, ach.id)) continue;
    if (ach.world_first) {
      if (hasOwnKey(run.s.meta.worldFirsts, ach.id)) continue;
      run.s.meta.worldFirsts[ach.id] = a.id;
      run.s.dirty.add('meta');
    }
    a.achievements[ach.id] = run.now;
    if (ach.title && !a.titles.includes(ach.title)) a.titles.push(ach.title);
    if (run.actor === a) tell(run, 'n.achievement', { ach: ref.ach(ach.id) });
    emit(run, 'achievement', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      to: [a.id],
      drama: ach.world_first ? 8 : 2,
      m: msg(ach.world_first ? 'ev.world_first' : 'ev.achievement', { actor: a.name, ach: ref.ach(ach.id) }),
      data: { ach: ach.id, world_first: ach.world_first, title: ach.title ?? null },
    });
  }
}

/** Increments a counter and unlocks any achievement that depends on it. */
export function bump(run: Run, a: AgentState, stat: string, n = 1): void {
  assertAmount(n, `stat ${stat}`);
  a.stats[stat] = (own(a.stats, stat) ?? 0) + n;
  checkAchievements(run, a, stat);
}

/** Raises a "highest value so far" counter (level, gold peak...). */
export function statMax(run: Run, a: AgentState, stat: string, value: number): void {
  if ((own(a.stats, stat) ?? 0) >= value) return;
  a.stats[stat] = value;
  checkAchievements(run, a, stat);
}

export function grantTitle(a: AgentState, title: string): void {
  if (!a.titles.includes(title)) a.titles.push(title);
}

/** Gives gold to an agent. Throws before changing anything unless the amount is a safe non-negative integer. */
export function addGold(run: Run, a: AgentState, amount: number): void {
  assertAmount(amount, `gold to ${a.id}`);
  assertAmount(a.gold, `gold of ${a.id}`);
  a.gold += amount;
  if (amount > 0) statMax(run, a, 'gold_peak', a.gold);
}

/** Takes gold from an agent, who must hold it (callers refuse first with `fail`). Throws before changing anything otherwise. */
export function takeGold(a: AgentState, amount: number): void {
  assertAmount(amount, `gold from ${a.id}`);
  if (!covers(a.gold, amount)) throw new Error(`ledger: ${a.id} holds ${a.gold} gold, ${amount} asked`);
  a.gold -= amount;
}

// ── XP and levels ────────────────────────────────────────────────────────────

/** Level cap for this agent right now (unclaimed agents stop early). */
export function levelCap(a: AgentState): number {
  return a.claimed ? BALANCE.maxLevel : BALANCE.unclaimedMaxLevel;
}

/**
 * Grants XP (food buffs applied) and resolves level-ups: full heal, new skills, events.
 * Returns the XP actually gained.
 */
export function gainXp(run: Run, a: AgentState, base: number): number {
  if (base <= 0) return 0;
  const cap = levelCap(a);
  if (a.level >= cap) return 0;
  const amount = Math.max(1, Math.round(base * (1 + buffValue(a, 'xp', run.now))));
  a.xp += amount;
  while (a.level < cap && a.xp >= xpToNext(a.level)) {
    a.xp -= xpToNext(a.level);
    a.level++;
    const d = derive(run.c, a, run.now);
    a.hp = d.maxHp;
    a.mp = d.maxMp;
    const cls = run.c.classes.get(a.cls)!;
    const learned = cls.skills.find((id) => run.c.skills.get(id)!.level === a.level);
    if (run.actor === a) {
      tell(run, 'n.level_up', { level: a.level });
      if (learned) tell(run, 'n.skill_learned', { skill: ref.skill(learned) });
      if (a.level === 5 && !a.profession) tell(run, 'n.profession_available');
    }
    emit(run, 'level_up', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      to: 'room',
      drama: a.level >= 10 ? 4 : 2,
      m: msg('ev.level_up', { actor: a.name, level: a.level }),
      data: { level: a.level },
    });
    statMax(run, a, 'level', a.level);
    if (!(a.stats.pvp_kills ?? 0)) statMax(run, a, 'pacifist_level', a.level);
  }
  if (a.level >= cap) {
    a.xp = 0;
    if (!a.claimed && run.actor === a) tell(run, 'n.unclaimed_cap', { level: cap });
  }
  return amount;
}

// ── Death ────────────────────────────────────────────────────────────────────

/** The agent drops where it stands and waits for a revive. `pvp`: felled by the agent named `by`, who took its toll. */
export function fall(run: Run, a: AgentState, by: string, pvp = false): void {
  a.hp = 0;
  a.combat = null;
  a.fallen = { at: run.now, until: run.now + BALANCE.death.fallenMs, by, ...(pvp ? { pvp: true as const } : {}) };
  run.s.timers.push({ at: a.fallen.until, kind: 'fallen', agent: a.id });
  bump(run, a, 'deaths');
  if (run.actor === a) tell(run, 'n.you_fall', { minutes: Math.round(BALANCE.death.fallenMs / 60_000) });
  emit(run, 'fallen', {
    room: a.room,
    actor: a.id,
    to: 'room',
    drama: 3,
    m: msg(pvp ? 'ev.fallen_pvp' : 'ev.fallen', { actor: a.name, by }),
    data: { by, ...(pvp ? { pvp: true } : {}) },
  });
  markAgent(run.s, a);
}

/**
 * Nobody came: wake at the temple with full health, minus a share of the carried gold. An agent felled by another
 * agent already paid its killer (PvP toll) and loses nothing more.
 */
export function wakeAtTemple(run: Run, a: AgentState): void {
  if (!a.fallen) return;
  const lost = a.fallen.pvp ? 0 : Math.floor(a.gold * BALANCE.death.goldLoss);
  takeGold(a, lost);
  a.fallen = null;
  a.combat = null;
  const from = a.room;
  relocate(run.s, a, BALANCE.templeRoom, run.now);
  const d = derive(run.c, a, run.now);
  a.hp = d.maxHp;
  a.mp = d.maxMp;
  a.regenAt = run.now;
  if (run.actor === a) tell(run, 'n.wake_temple', { gold: lost });
  emit(run, 'respawn', {
    room: a.room,
    actor: a.id,
    to: [a.id],
    m: msg('ev.respawn', { actor: a.name, gold: lost }),
    data: { from, lost },
  });
  markAgent(run.s, a);
}

/** A Cleric (or anything else) puts the agent back on its feet, in place and without loss. */
export function standUp(run: Run, a: AgentState): void {
  if (!a.fallen) return;
  a.fallen = null;
  a.hp = Math.max(1, Math.floor(derive(run.c, a, run.now).maxHp * BALANCE.death.reviveHp));
  a.regenAt = run.now;
  markAgent(run.s, a);
}
