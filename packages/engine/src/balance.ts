import type { ActionName } from '@ajwf/shared';

/**
 * Every balancing number of the game lives here (PLANEJAMENTO §16.5). Content values (monster stats, prices,
 * recipes) live in packages/content; this file holds the formulas' constants.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export const BALANCE = {
  maxLevel: 20,
  /** Agents without a confirmed owner stop gaining levels here. */
  unclaimedMaxLevel: 3,
  startGold: 25,
  startRoom: 'village.square',
  templeRoom: 'village.temple',

  ap: { max: 240, regenMs: 2 * MIN },

  hp: { base: 40, perVit: 8, perLevel: 10 },
  mp: { base: 20, perInt: 5 },
  /** Out-of-combat regeneration, as a fraction of the maximum per minute. Computed lazily from timestamps. */
  regen: { hpPerMin: 0.015, mpPerMin: 0.03 },

  inventory: { slots: 30, stackMax: 999, maxActiveQuests: 8 },

  combat: {
    randMin: 0.85,
    randMax: 1.15,
    /** damage = max(1, atk * mult * rand - def * defFactor) */
    defFactor: 0.5,
    /** Defense granted by each point of VIT. */
    vitDef: 0.5,
    critBase: 0.05,
    critPerAgi: 0.003,
    critMax: 0.4,
    critMult: 1.75,
    /** An agent stays "in combat" this long after the last blow traded with a monster. */
    engageMs: 60_000,
    /** A monster nobody hit for this long forgets its attackers and heals. */
    monsterResetMs: 3 * MIN,
    fleeBase: 0.55,
    fleePerAgi: 0.01,
    fleeMax: 0.95,
    /** Minimum share of the damage to get kill credit (quests, achievements). */
    creditShare: 0.1,
  },

  xp: {
    /** XP needed to go from `level` to `level + 1`. */
    curveBase: 100,
    curveExp: 1.5,
    /** Monsters far below the agent's level give less XP: -20% per level beyond `greyAfter`, never under `greyMin`. */
    greyAfter: 3,
    greyStep: 0.2,
    greyMin: 0.1,
    /** Monsters above the agent's level give a little more. */
    bonusPerLevel: 0.05,
    bonusMax: 0.25,
    gatherBase: 2,
    craftBase: 8,
    craftPerLevel: 3,
  },

  death: {
    /** Time lying fallen, waiting for a Cleric, before waking at the temple. */
    fallenMs: 3 * MIN,
    goldLoss: 0.1,
    reviveHp: 0.35,
  },

  rest: { baseCost: 4, costPerLevel: 2 },

  chat: { sayCooldownMs: 3000 },

  /** One game day lasts two real hours. Phases as fractions of the day. */
  day: { lengthMs: 2 * HOUR, dawn: 0, day: 0.06, dusk: 0.64, night: 0.7 },

  inbox: { size: 64 },
} as const;

/** AP cost per action (PLANEJAMENTO §11.4). Everything social is free. */
export const AP_COST: Partial<Record<ActionName, number>> = {
  move: 1,
  attack: 1,
  cast: 1,
  taunt: 1,
  scout: 1,
  pick_lock: 1,
  disarm: 1,
  revive: 1,
  pull_lever: 1,
  hold_gate: 1,
  read_runes: 1,
  enchant: 2,
  flee: 1,
  steal: 2,
  gather: 2,
  craft: 2,
};

export function apCost(action: ActionName): number {
  return AP_COST[action] ?? 0;
}

export function xpToNext(level: number): number {
  return Math.round(BALANCE.xp.curveBase * Math.pow(level, BALANCE.xp.curveExp));
}

/** XP multiplier for killing a monster of `monLevel` at `agentLevel`. */
export function levelGapXpMod(agentLevel: number, monLevel: number): number {
  const diff = agentLevel - monLevel;
  const x = BALANCE.xp;
  if (diff > x.greyAfter) return Math.max(x.greyMin, 1 - x.greyStep * (diff - x.greyAfter));
  if (diff < 0) return 1 + Math.min(x.bonusMax, -diff * x.bonusPerLevel);
  return 1;
}

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

export function dayFraction(now: number): number {
  const len = BALANCE.day.lengthMs;
  return (((now % len) + len) % len) / len;
}

export function dayPhase(now: number): DayPhase {
  const t = dayFraction(now);
  const d = BALANCE.day;
  if (t >= d.night) return 'night';
  if (t >= d.dusk) return 'dusk';
  if (t >= d.day) return 'day';
  return 'dawn';
}

export function isNight(now: number): boolean {
  return dayFraction(now) >= BALANCE.day.night;
}

/** Timestamp of the next moment the given day fraction happens strictly after `now`. */
export function nextDayFraction(now: number, fraction: number): number {
  const len = BALANCE.day.lengthMs;
  const start = Math.floor(now / len) * len;
  const t = start + fraction * len;
  return t > now ? t : t + len;
}

/** Real-time day index (24 h), used for daily quests, journal limits and the gazette. */
export function realDay(now: number): number {
  return Math.floor(now / (24 * HOUR));
}
