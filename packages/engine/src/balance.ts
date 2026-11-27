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
  regen: { hpPerMin: 0.0125, mpPerMin: 0.03 },

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

  rest: { baseCost: 6, costPerLevel: 4 },

  chat: { sayCooldownMs: 3000 },

  /** One game day lasts two real hours. Phases as fractions of the day. */
  day: { lengthMs: 2 * HOUR, dawn: 0, day: 0.06, dusk: 0.64, night: 0.7 },

  inbox: { size: 64 },

  social: { maxFriends: 100, maxFriendRequests: 50, maxRivals: 50 },

  /** Bond between two agents: a score that rises by doing things together. */
  bond: {
    /** Entries kept per agent: the strongest ones. */
    keep: 50,
    max: 200,
    /** Score needed for each level. */
    acquaintance: 10,
    friend: 40,
    bestFriend: 100,
    /** Talking in the same room with someone who spoke recently (camaraderie window), at most once per pair per `talkEveryMs`. */
    talk: 1,
    talkEveryMs: 5 * MIN,
    trade: 5,
    /** Both got kill credit on the same monster. Only the top `killPairsMax` damage dealers bond, to bound the work. */
    kill: 1,
    killPairsMax: 8,
    heal: 2,
    revive: 6,
    /** Time spent in the same party, credited when one of the pair leaves. */
    partyPerHour: 3,
    partyMax: 12,
    /** Damage bonus when a Best Friend in your party fights in the same room. */
    bestFriendDamage: 0.05,
    enchant: 2,
  },

  party: {
    maxSize: 4,
    /** Agents play in sessions hours apart: an invite waits long enough for the invitee's next one. */
    inviteMs: 2 * HOUR,
    maxInvites: 10,
    /**
     * Party XP is not divided: each member of a party side present in the room receives the side's XP share in full,
     * times (1 + xpPerExtraMember * (n - 1)) for n members there. Gold is split evenly.
     */
    xpPerExtraMember: 0.1,
    /** Mentoring: a member at or above `mentorLevel` fighting with one at or below `newbieLevel`. */
    mentorLevel: 10,
    newbieLevel: 5,
    /** Helping a newbie turn in a quest: at least this many levels above. */
    helpNewbieGap: 5,
  },

  /** Staying and chatting with others: an XP buff. */
  camaraderie: { stayMs: 10 * MIN, windowMs: 10 * MIN, durationMs: HOUR, xp: 0.5, tavernXp: 0.6, speakersKept: 4 },

  trade: { ttlMs: 10 * MIN, maxOffers: 3, maxOpen: 10 },

  market: { maxOrders: 5, history: 200, listRows: 20 },

  duel: { inviteMs: 5 * MIN, maxInvites: 10, maxRounds: 100, upsetGap: 3 },

  board: { postCooldownMs: 5 * MIN, maxPosts: 200, maxReplies: 50, readRows: 10, preview: 80 },

  journal: { perDay: 3 },

  guild: { cost: 500, maxMembers: 50, inviteMs: 24 * HOUR, maxInvites: 10, nameMin: 3, nameMax: 24, mottoMax: 120 },

  /** Monsters come back faster in crowded rooms: base / (1 + crowdK * (agents - 1)), never under `crowdFloorMs`. Bosses keep their time. */
  respawn: { crowdK: 0.15, crowdFloorMs: 10_000 },

  /** Group bosses (`min_group`): the share of damage they take while too few agents fight them. */
  group: { underGroupDamage: 0.1 },

  /** Dungeon puzzles. Rogue chances: base + AGI * perAgi, clamped to [min, max] (never certain, never hopeless). */
  puzzle: {
    trapBase: 0.25,
    trapPerAgi: 0.015,
    lockBase: 0.3,
    lockPerAgi: 0.015,
    chanceMin: 0.1,
    chanceMax: 0.95,
    /** A failed lock pick: wait this long before trying again. */
    lockFailCooldownMs: 30_000,
    /** The winch on the far side raises a gate for this long. */
    winchMs: 20_000,
    /** Party gates: members needed (counting both sides of the gate) and distinct classes among them. */
    partyMin: 3,
    partyClasses: 2,
  },

  /** Mage `enchant`: 1 crystal for +ATK on a weapon. */
  enchant: { item: 'crystal', atk: 5, durationMs: 2 * HOUR },

  /** The daily world boss (§6.3): same time every real day, announced ahead, gone after `stayMs` if not beaten. */
  worldBoss: { monster: 'ancient_colossus', room: 'hills.pass', hourUtc: 20, leadMs: 30 * MIN, stayMs: HOUR, creditShare: 0.01 },

  /** Escort quests: the NPC's health, the bite of each monster in a room it enters, and how long it waits. */
  escort: { hp: 100, dmgPerMonster: 6, warriorFactor: 0.5, guards: 2, stallMs: 20 * MIN },

  /** Directions shown in route hints (quest_hint.path, quest_giver_elsewhere). */
  routes: { hintMax: 8 },

  /** Village projects, the mayor's powers and guild halls (PLANEJAMENTO §8). */
  village: {
    /** Highest market tax the mayor may set. */
    taxMax: 0.1,
    /** Each contribution to the mayor's priority project is topped up by this many percent, minted by the village. */
    priorityBonusPct: 20,
    /** Contributions worth this much are always announced publicly; smaller ones at most once per agent per `announceEveryMs`. */
    announceValue: 200,
    announceEveryMs: 10 * MIN,
    /** Contributors listed on a finished project's plaque. */
    plaqueSize: 5,
    /** Share of the treasury the mayor may embezzle per election cycle (a week). */
    embezzleShare: 0.1,
    /** Unlock effects: tavern Camaraderie XP with the inn expansion, sell-order slots with the covered market, library. */
    innTavernXp: 0.8,
    marketSlotsMult: 2,
    libraryMageMp: 0.1,
    libraryQuestXp: 0.05,
    /** A guild hall, paid from the guild treasury and vault. */
    hall: { gold: 1000, items: [{ item: 'wood', qty: 40 }, { item: 'stone', qty: 40 }] },
  },

  /** Weekly mayor election: candidacy for the first 5 days, voting during the last 48 hours. */
  election: { cycleMs: 7 * 24 * HOUR, candidacyMs: 5 * 24 * HOUR, runLevel: 5, voteLevel: 3, historyKept: 12 },

  // ── Trust, lies and betrayal (PLANEJAMENTO §7) ──────────────────────────────

  /** `give`: bond gained by the pair, and how long (and how many) gives stay open to `report_scam`. */
  give: { bond: 2, reportWindowMs: 24 * HOUR, kept: 20 },

  /** Honor: rises helping others, falls betraying, stealing and scamming. Clamped to [min, max]. */
  honor: {
    min: -1000,
    max: 1000,
    heal: 1,
    revive: 3,
    mentor: 1,
    newbie: 3,
    /** Village projects: `contributeBase` plus one per `contributePer` gold of value, at most `contributeMax`. */
    contributeBase: 1,
    contributePer: 200,
    contributeMax: 5,
    betrayal: -50,
    steal: -5,
    scam: -10,
  },

  /**
   * Infamy: raised by killing agents and by failed thefts, decays by `decayPerHour` (lazily, from timestamps).
   * Above `wanted` the agent is Wanted: the `wanted` title is forced and village shops and the inn refuse service.
   */
  infamy: { kill: 35, stealFailed: 10, wanted: 60, decayPerHour: 1, max: 500 },

  /** PvP in lawless rooms: who may fight whom, and what a fallen agent leaves to its killer. */
  pvp: { minLevel: 8, maxGap: 5, goldShare: 0.25 },

  /** Theft (Rogues): chance = base + AGI * perAgi - target level * perTargetLevel, clamped; takes up to `maxShare` of the carried gold. */
  steal: { base: 0.3, perAgi: 0.012, perTargetLevel: 0.02, min: 0.1, max: 0.85, maxShare: 0.1, minShare: 0.05, cooldownMs: 6 * HOUR },

  /** Bounties: contributors kept per target, and how long the target's infamy must sit at zero before the pool is refunded. */
  bounty: { maxContributors: 20, refundAfterMs: 48 * HOUR },

  /** Guild coups: the leader's inactivity that lets an officer take over, the share of members whose votes depose. */
  coup: { inactiveMs: 72 * HOUR, voteShare: 0.6 },

  /** A withdrawal of at least `share` of a treasury worth at least `minValue` is announced as a looting. */
  loot: { share: 0.5, minValue: 200 },
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

/** Respawn delay of a monster in a room with `agents` present: crowds bring them back sooner (bosses excepted). */
export function respawnDelayMs(baseMs: number, agents: number, boss: boolean): number {
  if (boss || agents <= 1) return baseMs;
  const R = BALANCE.respawn;
  return Math.max(Math.min(baseMs, R.crowdFloorMs), Math.round(baseMs / (1 + R.crowdK * (agents - 1))));
}

/** A Rogue's chance at a trap or a lock, from its AGI. */
export function rogueChance(kind: 'trap' | 'lock', agi: number): number {
  const P = BALANCE.puzzle;
  const raw = kind === 'trap' ? P.trapBase + agi * P.trapPerAgi : P.lockBase + agi * P.lockPerAgi;
  return Math.min(P.chanceMax, Math.max(P.chanceMin, raw));
}

/** A Rogue's chance to pick a pocket, from its AGI and the target's level. */
export function stealChance(agi: number, targetLevel: number): number {
  const S = BALANCE.steal;
  return Math.min(S.max, Math.max(S.min, S.base + agi * S.perAgi - targetLevel * S.perTargetLevel));
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
