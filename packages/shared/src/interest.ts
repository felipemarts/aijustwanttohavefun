/**
 * Interest scoring for director mode: how much an event makes its actor worth watching. The server scores every
 * spectator-visible event with `eventPoints` and sends the increments in `world` batches; the web mock uses the same
 * function, so the whole path works without a server. Only events a spectator may see are ever scored (the caller
 * checks visibility), so the score reveals nothing the spectator could not see anyway.
 */

/** Points by event type (engine event names). Anything not listed scores `INTEREST.defaultPoints`. */
export const INTEREST_POINTS: Readonly<Record<string, number>> = {
  // Life and death: an agent falls, comes back, or is brought back.
  fallen: 10,
  revive: 8,
  // Fights with monsters: a kill (a boss or world boss kill is scored by `bossKillPoints`), a hit, a heal.
  kill: 4,
  attack: 3,
  heal: 3,
  // Agent against agent: PvP attacks (an `attack` on an agent, see `pvpAttackPoints`), PvP kills, theft, betrayal.
  pvp_kill: 8,
  steal: 8,
  betrayal: 8,
  duel: 6,
  // Fortune and progress (a world first is an `achievement` scored by `worldFirstPoints`).
  rare_drop: 7,
  achievement: 6,
  level_up: 5,
  // Civic life: elections and the mayor's acts.
  election_phase: 6,
  election_result: 6,
  run_for_mayor: 6,
  vote: 6,
  mayor_priority: 6,
  mayor_tax: 6,
  mayor_fund: 6,
  mayor_embezzle: 6,
  // Social bonds: guilds, parties, trades.
  guild_founded: 5,
  party_join: 4,
  trade: 3,
  market_trade: 3,
  // Everyday life: talk, work, gestures, walking.
  say: 2,
  craft: 2,
  emote: 1,
  gather: 1,
  move: 0.5,
  // The fountain (events added by the fountain feature; scored by name ahead of it).
  wish: 2,
  fountain_jackpot: 10,
};

export const INTEREST = {
  /** Event types not in the table. */
  defaultPoints: 1,
  /** A kill of a boss or world boss. */
  bossKillPoints: 10,
  /** An achievement that is a world first. */
  worldFirstPoints: 10,
  /** An `attack` whose target is an agent. */
  pvpAttackPoints: 8,
  /** A `say` answering another agent who spoke in the same room within `conversationMs`. */
  conversationBonus: 2,
  conversationMs: 20_000,
  /** Scripted bots score this fraction, so real agents win ties. */
  botFactor: 0.4,
  /** An agent who is the target of an event gets this share of its points. */
  targetShare: 0.5,
  /** Increments below this are not sent. */
  minPoints: 2,
  /** At most this many increments per `world` batch (the largest are kept). */
  maxPerBatch: 12,
} as const;

/** What the scoring needs to know about one event. */
export type ScoreInput = {
  type: string;
  /** The event's own drama. */
  drama?: number;
  /** A kill of a boss or world boss. */
  boss?: boolean;
  /** An achievement that is a world first. */
  worldFirst?: boolean;
  /** The event's target is an agent (an `attack` then is PvP). */
  vsAgent?: boolean;
  /** A `say` with another agent speaking in the same room recently (see `SayTracker`). */
  conversation?: boolean;
  /** The agent being scored is a scripted bot. */
  bot?: boolean;
};

/** Points the actor of an event earns: base weight by type plus the event's drama, adjusted for bots. */
export function eventPoints(e: ScoreInput): number {
  let base = INTEREST_POINTS[e.type] ?? INTEREST.defaultPoints;
  if (e.type === 'kill' && e.boss) base = INTEREST.bossKillPoints;
  if (e.type === 'achievement' && e.worldFirst) base = INTEREST.worldFirstPoints;
  if (e.type === 'attack' && e.vsAgent) base = INTEREST.pvpAttackPoints;
  if (e.type === 'say' && e.conversation) base += INTEREST.conversationBonus;
  const drama = typeof e.drama === 'number' && Number.isFinite(e.drama) && e.drama > 0 ? e.drama : 0;
  return (base + drama) * (e.bot ? INTEREST.botFactor : 1);
}

/** One increment of an agent's interest, as carried by `world` batches (`batch.interest`). */
export type InterestIncrement = {
  /** agent name */
  n: string;
  /** room id where it happened */
  r: string;
  /** points, rounded to one decimal */
  p: number;
  /** event type */
  e: string;
};

/** Drops increments below `INTEREST.minPoints` and keeps the largest `max`, in their original order. */
export function selectIncrements(list: readonly InterestIncrement[], max: number = INTEREST.maxPerBatch): InterestIncrement[] {
  const kept = list.map((x, i) => ({ x, i })).filter(({ x }) => x.p >= INTEREST.minPoints);
  if (kept.length > max) kept.sort((a, b) => b.x.p - a.x.p || a.i - b.i).length = max;
  return kept.sort((a, b) => a.i - b.i).map(({ x }) => x);
}

export const roundPoints = (p: number) => Math.round(p * 10) / 10;

/** Remembers who spoke where, to tell a conversation from a monologue. */
export class SayTracker {
  private last = new Map<string, Map<string, number>>();

  /** Records that `who` spoke in `room` at `ts`; true when another agent spoke there within `conversationMs`. */
  spoke(room: string, who: string, ts: number): boolean {
    let speakers = this.last.get(room);
    if (!speakers) this.last.set(room, (speakers = new Map()));
    let answer = false;
    for (const [other, at] of speakers) {
      if (ts - at > INTEREST.conversationMs) speakers.delete(other);
      else if (other !== who) answer = true;
    }
    speakers.set(who, ts);
    return answer;
  }

  /** Forgets rooms where nobody spoke recently (call now and then). */
  prune(now: number): void {
    for (const [room, speakers] of this.last) {
      for (const [who, at] of speakers) if (now - at > INTEREST.conversationMs) speakers.delete(who);
      if (!speakers.size) this.last.delete(room);
    }
  }
}
