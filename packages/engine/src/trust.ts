import { addGold, bump, grantTitle } from './agent';
import { BALANCE } from './balance';
import { emit, markAgent, msg, tell, type Run } from './run';
import type { AgentState, Bounty, WorldState } from './types';
import { VILLAGE_ID } from './village-state';

/**
 * Trust, lies and betrayal (PLANEJAMENTO §7): Honor, Infamy and the Wanted status, bounties, and the public
 * reputation read model. The server guarantees the rules; whom to trust is the agents' problem.
 */

const HOUR = 3_600_000;

/** Granted while the agent is Wanted and forced as its displayed title (titles.yaml). */
export const WANTED_TITLE = 'wanted';

// ── Honor ────────────────────────────────────────────────────────────────────

/** Moves an agent's Honor by `n` (either way), within the bounds. */
export function addHonor(run: Run, a: AgentState, n: number): void {
  if (!n) return;
  const H = BALANCE.honor;
  a.honor = Math.max(H.min, Math.min(H.max, Math.round((a.honor ?? 0) + n)));
  markAgent(run.s, a);
}

/** Honor for a gift to a village project, growing a little with its value. */
export function contributionHonor(value: number): number {
  const H = BALANCE.honor;
  return Math.min(H.contributeMax, H.contributeBase + Math.floor(value / H.contributePer));
}

// ── Infamy and Wanted ────────────────────────────────────────────────────────

/** Infamy right now: the stored value minus what decayed since it was stored. */
export function infamyNow(a: AgentState, now: number): number {
  if (!(a.infamy > 0)) return 0;
  return Math.max(0, a.infamy - (BALANCE.infamy.decayPerHour * Math.max(0, now - a.infamyAt)) / HOUR);
}

/** Infamy as shown to people: a whole number, never 0 while any is left. */
export function shownInfamy(a: AgentState, now: number): number {
  const n = infamyNow(a, now);
  return n > 0 ? Math.ceil(n - 1e-9) : 0;
}

/** When the infamy, decaying from its stored value, comes down to `level`. */
function infamyFallsTo(a: AgentState, level: number): number {
  return a.infamyAt + Math.ceil(((a.infamy - level) * HOUR) / BALANCE.infamy.decayPerHour);
}

export function isWanted(a: AgentState): boolean {
  return a.wanted !== null && a.wanted !== undefined;
}

/** Whole hours until a Wanted agent's infamy falls back under the line (at least 1). */
export function wantedHours(a: AgentState, now: number): number {
  return a.wanted ? Math.max(1, Math.ceil((a.wanted.until - now) / HOUR)) : 0;
}

/** Raises an agent's infamy. Crossing the line makes it Wanted; while Wanted, it pushes the end further away. */
export function raiseInfamy(run: Run, a: AgentState, n: number): void {
  const I = BALANCE.infamy;
  a.infamy = Math.min(I.max, infamyNow(a, run.now) + n);
  a.infamyAt = run.now;
  markAgent(run.s, a);
  if (a.infamy <= I.wanted) return;
  const until = infamyFallsTo(a, I.wanted);
  if (a.wanted) a.wanted.until = until;
  else becomeWanted(run, a, until);
  // Only the timer at `wanted.until` acts; earlier ones are stale and do nothing.
  run.s.timers.push({ at: until, kind: 'wanted', agent: a.id });
  run.s.dirty.add('timers');
}

function becomeWanted(run: Run, a: AgentState, until: number): void {
  a.wanted = { since: run.now, prev: a.title, until };
  grantTitle(a, WANTED_TITLE);
  a.title = WANTED_TITLE;
  const hours = wantedHours(a, run.now);
  if (run.actor === a) tell(run, 'n.wanted', { hours });
  emit(run, 'wanted', {
    room: a.room,
    actor: a.id,
    vis: 'public',
    to: [a.id],
    drama: 6,
    m: msg('ev.wanted', { actor: a.name }),
    data: { agent: a.name, infamy: shownInfamy(a, run.now), hours },
  });
}

function clearWanted(run: Run, a: AgentState): void {
  const prev = a.wanted?.prev ?? null;
  a.wanted = null;
  a.titles = a.titles.filter((t) => t !== WANTED_TITLE);
  a.title = prev && a.titles.includes(prev) ? prev : null;
  markAgent(run.s, a);
  emit(run, 'wanted_cleared', {
    room: a.room,
    actor: a.id,
    vis: 'public',
    to: [a.id],
    drama: 2,
    m: msg('ev.wanted_cleared', { actor: a.name }),
    data: { agent: a.name },
  });
}

/** The `wanted` timer fired: the agent's infamy is back under the line, unless it rose since (a later timer then acts). */
export function wantedTimer(run: Run, agentId: string, at: number): void {
  const a = run.s.agents.get(agentId);
  if (!a?.wanted || a.wanted.until !== at) return;
  clearWanted(run, a);
}

// ── Bounties ─────────────────────────────────────────────────────────────────

export function bountyOn(s: WorldState, agentId: string): number {
  return s.bounties[agentId]?.total ?? 0;
}

/** When a bounty on this agent may be refunded: its infamy reached zero, plus the waiting time. */
function refundDue(a: AgentState): number {
  const zero = a.infamy > 0 ? infamyFallsTo(a, 0) : a.infamyAt;
  return zero + BALANCE.bounty.refundAfterMs;
}

function scheduleRefund(run: Run, b: Bounty, due: number): void {
  if (b.due === due) return;
  b.due = due;
  run.s.timers.push({ at: due, kind: 'bounty', target: b.target });
  run.s.dirty.add('timers');
}

/** Whether `payer` can add to the bounty on this agent: a new contributor needs a free line. */
export function bountyHasRoom(s: WorldState, target: AgentState, payer: string): boolean {
  const b = s.bounties[target.id];
  return !b || b.by.length < BALANCE.bounty.maxContributors || b.by.some((x) => x.id === payer);
}

/** Escrows gold on an agent's head. The caller took the gold from the payer and checked `bountyHasRoom`. */
export function addBounty(run: Run, target: AgentState, payer: { id: string; name: string | null }, gold: number): Bounty {
  const s = run.s;
  let b = s.bounties[target.id];
  if (!b) s.bounties[target.id] = b = { target: target.id, total: 0, by: [], at: run.now, due: 0 };
  const line = b.by.find((x) => x.id === payer.id);
  if (line) line.gold += gold;
  else b.by.push({ id: payer.id, name: payer.name, gold });
  b.total += gold;
  scheduleRefund(run, b, refundDue(target));
  s.dirty.add('bounties');
  return b;
}

/** The hunter who felled the target collects the whole pool. Returns the gold collected (0 without a bounty). */
export function claimBounty(run: Run, hunter: AgentState, target: AgentState): number {
  const b = run.s.bounties[target.id];
  if (!b) return 0;
  delete run.s.bounties[target.id];
  run.s.dirty.add('bounties');
  addGold(run, hunter, b.total);
  bump(run, hunter, 'bounties_claimed');
  markAgent(run.s, hunter);
  if (run.actor === hunter) tell(run, 'n.bounty_claimed', { name: target.name, gold: b.total });
  emit(run, 'bounty_claimed', {
    room: hunter.room,
    actor: hunter.id,
    target: target.id,
    vis: 'public',
    to: [hunter.id, ...b.by.map((x) => x.id).filter((id) => id !== VILLAGE_ID)],
    drama: 8,
    m: msg('ev.bounty_claimed', { actor: hunter.name, name: target.name, gold: b.total }),
    data: { hunter: hunter.name, target: target.name, gold: b.total },
  });
  return b.total;
}

/**
 * The refund check of a bounty: once its target's infamy has been at zero long enough, every contributor gets its
 * own gold back (the village into the treasury). Earlier, it waits for the new due time.
 */
export function bountyTimer(run: Run, targetId: string, at: number): void {
  const s = run.s;
  const b = s.bounties[targetId];
  if (!b || b.due !== at) return;
  const target = s.agents.get(targetId);
  const due = target ? refundDue(target) : at;
  if (due > run.now) {
    scheduleRefund(run, b, due);
    return;
  }
  delete s.bounties[targetId];
  s.dirty.add('bounties');
  const paid: string[] = [];
  for (const line of b.by) {
    const who = line.id === VILLAGE_ID ? undefined : s.agents.get(line.id);
    if (who) {
      addGold(run, who, line.gold);
      markAgent(s, who);
      paid.push(who.id);
    } else {
      s.village.treasury += line.gold;
      s.dirty.add('village');
    }
  }
  emit(run, 'bounty_refunded', {
    ...(target ? { room: target.room } : {}),
    target: targetId,
    vis: 'public',
    to: paid,
    drama: 2,
    m: msg('ev.bounty_refunded', { name: target?.name ?? '?', gold: b.total }),
    data: { target: target?.name ?? null, gold: b.total },
  });
}

// ── Reputation ───────────────────────────────────────────────────────────────

/** Everything a public profile shows about an agent's trustworthiness (§7.5). */
export type Reputation = {
  name: string;
  /** Guaranteed trades completed. */
  trades: number;
  /** Scam reports filed against this agent. */
  scam_reports: number;
  /** Scams this agent reported falling for. */
  scams_suffered: number;
  betrayals: number;
  pvp_kills: number;
  bounties_claimed: number;
  /** Gold currently escrowed on its head. */
  bounty: number;
  honor: number;
  infamy: number;
  wanted: boolean;
};

/** The public reputation of an agent, or null when there is no such agent. Pure read. */
export function reputation(s: WorldState, agentId: string, now: number): Reputation | null {
  const a = s.agents.get(agentId);
  if (!a) return null;
  const st = a.stats;
  return {
    name: a.name,
    trades: st.trades ?? 0,
    scam_reports: st.scams_reported ?? 0,
    scams_suffered: st.scams_suffered ?? 0,
    betrayals: st.betrayals ?? 0,
    pvp_kills: st.pvp_kills ?? 0,
    bounties_claimed: st.bounties_claimed ?? 0,
    bounty: bountyOn(s, a.id),
    honor: a.honor ?? 0,
    infamy: shownInfamy(a, now),
    wanted: isWanted(a),
  };
}
