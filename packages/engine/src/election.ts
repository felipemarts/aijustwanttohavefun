import { bump, grantTitle } from './agent';
import { BALANCE } from './balance';
import { emit, markAgent, msg, type Run } from './run';
import type { AgentState, WorldState } from './types';
import { electionDue, newElection, type ElectionRecord, type Mayor } from './village-state';

/** Title the mayor wears while in office; removed when the term ends. */
export const MAYOR_TITLE = 'mayor';

/**
 * Weekly mayor election (PLANEJAMENTO §8.2), driven by a single `election` timer on the heap. The schedule lives in
 * `village.election`: candidacy from `start`, voting from `voteAt`, closing at `end`, and the next cycle starts at
 * once. Each phase change is a public event.
 */

export function isMayor(s: WorldState, a: AgentState): boolean {
  return s.village.mayor?.id === a.id;
}

/** Puts the election timer on the heap for the next phase change. */
export function scheduleElection(s: WorldState): void {
  s.timers.push({ at: electionDue(s.village.election), kind: 'election' });
  s.dirty.add('timers');
}

/** The `election` timer fired: open the voting, or close the election and start the next cycle. */
export function electionTick(run: Run): void {
  const s = run.s;
  const e = s.village.election;
  // A stale timer (there is always exactly one live one): nothing to do yet.
  if (run.now < electionDue(e)) return;
  if (e.phase === 'candidacy') {
    e.phase = 'voting';
    emit(run, 'election_phase', {
      room: 'village.town_hall',
      vis: 'public',
      drama: 4,
      m: msg('ev.election_voting', { n: e.candidates.length, hours: Math.round((e.end - e.voteAt) / 3_600_000) }),
      data: { election: e.n, phase: e.phase, ends: e.end, candidates: e.candidates.map((c) => c.name) },
    });
  } else {
    closeElection(run);
    // The next cycle starts when this one ended, unless the world was stopped for longer than a candidacy phase.
    const start = run.now - e.end > BALANCE.election.candidacyMs ? run.now : e.end;
    const next = newElection(e.n + 1, start);
    s.village.election = next;
    emit(run, 'election_phase', {
      room: 'village.town_hall',
      vis: 'public',
      drama: 2,
      m: msg('ev.election_candidacy', { election: next.n }),
      data: { election: next.n, phase: next.phase, ends: next.voteAt },
    });
  }
  s.dirty.add('village');
  scheduleElection(s);
}

function takeOffice(run: Run, a: AgentState, n: number): Mayor {
  // A Wanted mayor keeps wearing `wanted` until its infamy fades; `mayor` shows after that.
  const m: Mayor = { id: a.id, name: a.name, since: run.now, election: n, prevTitle: a.wanted ? a.wanted.prev : a.title };
  grantTitle(a, MAYOR_TITLE);
  if (a.wanted) a.wanted.prev = MAYOR_TITLE;
  else a.title = MAYOR_TITLE;
  markAgent(run.s, a);
  return m;
}

function stepDown(run: Run, m: Mayor): void {
  const a = run.s.agents.get(m.id);
  if (!a) return;
  a.titles = a.titles.filter((t) => t !== MAYOR_TITLE);
  const back = m.prevTitle && a.titles.includes(m.prevTitle) ? m.prevTitle : null;
  if (a.title === MAYOR_TITLE) a.title = back;
  if (a.wanted?.prev === MAYOR_TITLE) a.wanted.prev = back;
  markAgent(run.s, a);
}

/**
 * Counts the votes. Most votes wins; a tie goes to the earliest candidacy; candidates banned or retired since cannot
 * win. No candidates, or no votes, means no mayor: the previous one steps down all the same.
 */
function closeElection(run: Run): void {
  const s = run.s;
  const v = s.village;
  const e = v.election;
  let winner: AgentState | null = null;
  let best = 0;
  for (const c of e.candidates) {
    const n = e.tally[c.id] ?? 0;
    const a = s.agents.get(c.id);
    if (n > best && a?.status === 'active') {
      winner = a;
      best = n;
    }
  }
  const prev = v.mayor;
  if (prev && prev.id !== winner?.id) {
    stepDown(run, prev);
    v.mayor = null;
  }
  if (winner) {
    if (v.mayor) v.mayor.election = e.n;
    else v.mayor = takeOffice(run, winner, e.n);
  }
  // A new mayor picks a new priority; a re-elected one keeps theirs.
  if (!winner || winner.id !== prev?.id) v.priority = null;

  const record: ElectionRecord = {
    n: e.n,
    start: e.start,
    end: e.end,
    winner: winner?.name ?? null,
    winnerId: winner?.id ?? null,
    votes: e.candidates.map((c) => ({ id: c.id, name: c.name, votes: e.tally[c.id] ?? 0 })),
  };
  v.history.push(record);
  if (v.history.length > BALANCE.election.historyKept) v.history.splice(0, v.history.length - BALANCE.election.historyKept);

  const out = prev && prev.id !== winner?.id ? prev.name : null;
  const key = winner ? (prev?.id === winner.id ? 'ev.election_reelected' : 'ev.election_won') : e.candidates.length ? 'ev.election_no_votes' : 'ev.election_no_candidates';
  emit(run, 'election_result', {
    room: 'village.town_hall',
    ...(winner ? { actor: winner.id } : {}),
    vis: 'public',
    to: winner ? [winner.id] : 'none',
    drama: winner ? 9 : out ? 6 : 3,
    m: msg(key, { actor: winner?.name ?? '', votes: best, election: e.n, name: out ?? '' }),
    data: { ...record, voters: Object.keys(e.votes).length, previous: out },
  });

  if (!winner) return;
  bump(run, winner, 'mayor_elected');
  markAgent(s, winner);
  // Only the winner's voters: bounded by the votes cast, never a scan of all agents.
  for (const [voter, cand] of Object.entries(e.votes)) {
    if (cand !== winner.id) continue;
    const a = s.agents.get(voter);
    if (!a) continue;
    bump(run, a, 'votes_for_winner');
    markAgent(s, a);
  }
}
