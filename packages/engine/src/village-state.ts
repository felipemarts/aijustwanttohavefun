import { BALANCE } from './balance';

/**
 * The village as a civic entity (PLANEJAMENTO §8): treasury and market tax, projects, mayor and elections, guild
 * halls. Plain JSON, persisted under the world key `village`. Only types and constructors live here, so that any
 * module can import them without cycles; the rules are in village.ts and election.ts.
 */

/** Contributor id used for gold the village itself puts into a project (mayor funding, priority bonus). */
export const VILLAGE_ID = '@village';

/** One line of a project plaque. `name` is null for the village itself. */
export type PlaqueLine = { id: string; name: string | null; value: number };

/** What a project received so far. Created on the first contribution; progress never goes back. */
export type ProjectState = {
  gold: number;
  /** item id -> quantity delivered (never above the cost). */
  items: Record<string, number>;
  /**
   * contributor id (or `@village`) -> value given, items at base value. Key order is the order of first
   * contribution, which breaks ties on the plaque.
   */
  by: Record<string, number>;
  /** Completion time; absent while in progress. */
  doneAt?: number;
  /** The top contributors at completion, best first. */
  plaque?: PlaqueLine[];
};

/** `platform` is agent-written text, already cleaned; `lang` is the language it was written in. */
export type Candidate = { id: string; name: string; at: number; platform: string; lang: string };

export type ElectionPhase = 'candidacy' | 'voting';

/** The current weekly election cycle: candidacy from `start`, voting from `voteAt`, closing at `end`. */
export type Election = {
  n: number;
  start: number;
  voteAt: number;
  end: number;
  phase: ElectionPhase;
  /** In order of candidacy (the earliest wins a tie). */
  candidates: Candidate[];
  /** voter id -> candidate id. One entry per voter: a vote can be neither repeated nor changed. */
  votes: Record<string, string>;
  /** candidate id -> votes received. Kept in step with `votes`. */
  tally: Record<string, number>;
};

/** A closed election, as kept in the bounded history and emitted in `election_result`. */
export type ElectionRecord = {
  n: number;
  start: number;
  end: number;
  winner: string | null;
  winnerId: string | null;
  /** Candidates in order of candidacy with their votes. */
  votes: { id: string; name: string; votes: number }[];
};

export type Mayor = { id: string; name: string; since: number; election: number; prevTitle: string | null };

export type GuildHall = { guild: string; at: number };

/** The agent the statue honors: the top overall contributor when the statue was completed. */
export type Honoree = { id: string; name: string; sprite: string; value: number; at: number };

export type Village = {
  taxRate: number;
  treasury: number;
  /** project id -> state, only for projects that received something. */
  projects: Record<string, ProjectState>;
  /** Project chosen by the mayor; contributions to it are topped up by the village. */
  priority: string | null;
  mayor: Mayor | null;
  election: Election;
  /** Latest closed elections, oldest first (bounded). */
  history: ElectionRecord[];
  /** Gold the mayor took from the treasury during election cycle `election`. */
  embezzled: { election: number; gold: number };
  /** plot room id -> the guild hall standing there. */
  halls: Record<string, GuildHall>;
  /** Top overall contributor so far (value across every project). */
  top: { id: string; value: number } | null;
  honoree: Honoree | null;
};

export function newElection(n: number, start: number): Election {
  const E = BALANCE.election;
  return { n, start, voteAt: start + E.candidacyMs, end: start + E.cycleMs, phase: 'candidacy', candidates: [], votes: {}, tally: {} };
}

/** A village with nothing built and the first election cycle starting at `now`. */
export function newVillage(now: number): Village {
  return {
    taxRate: 0,
    treasury: 0,
    projects: {},
    priority: null,
    mayor: null,
    election: newElection(1, now),
    history: [],
    embezzled: { election: 0, gold: 0 },
    halls: {},
    top: null,
    honoree: null,
  };
}

/** When the election timer must fire next: the start of voting, or the close. */
export function electionDue(e: Election): number {
  return e.phase === 'candidacy' ? e.voteAt : e.end;
}
