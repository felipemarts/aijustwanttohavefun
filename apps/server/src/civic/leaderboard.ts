import { shownInfamy, type AgentState, type WorldState } from '@ajwf/engine';
import type { Leaderboard, LeaderboardBy } from '@ajwf/shared';

export const LEADERBOARD_BY: readonly LeaderboardBy[] = ['level', 'wealth', 'honor', 'infamy', 'contribution', 'friends'];
export const LEADERBOARD_SIZE = 50;
/** Every board is recomputed in one pass over the agents at most this often (§13.1: never per request). */
export const LEADERBOARD_TTL_MS = 60_000;

type Metric = { value: (a: AgentState, now: number) => number; tie?: (a: AgentState) => number; positiveOnly: boolean };

const METRICS: Record<LeaderboardBy, Metric> = {
  level: { value: (a) => a.level, tie: (a) => a.xp, positiveOnly: false },
  wealth: { value: (a) => a.gold, positiveOnly: false },
  honor: { value: (a) => a.honor ?? 0, positiveOnly: true },
  infamy: { value: (a, now) => shownInfamy(a, now), positiveOnly: true },
  contribution: { value: (a) => a.stats.contributions ?? 0, positiveOnly: true },
  friends: { value: (a) => a.friends.length, positiveOnly: true },
};

/** Rankings for `/leaderboard`: all six boards from one scan, cached for a minute. */
export class Leaderboards {
  private cache: { at: number; boards: Map<LeaderboardBy, Leaderboard> } | null = null;

  constructor(
    private state: WorldState,
    private now: () => number,
  ) {}

  get(by: LeaderboardBy): Leaderboard {
    const now = this.now();
    if (!this.cache || now - this.cache.at >= LEADERBOARD_TTL_MS) this.cache = { at: now, boards: this.compute(now) };
    return this.cache.boards.get(by)!;
  }

  private compute(now: number): Map<LeaderboardBy, Leaderboard> {
    const lists = new Map<LeaderboardBy, { a: AgentState; v: number; t: number }[]>(LEADERBOARD_BY.map((b) => [b, []]));
    for (const a of this.state.agents.values()) {
      if (a.status !== 'active') continue;
      for (const by of LEADERBOARD_BY) {
        const m = METRICS[by];
        const v = m.value(a, now);
        if (m.positiveOnly && !(v > 0)) continue;
        lists.get(by)!.push({ a, v, t: m.tie?.(a) ?? 0 });
      }
    }
    const out = new Map<LeaderboardBy, Leaderboard>();
    for (const [by, list] of lists) {
      list.sort((x, y) => y.v - x.v || y.t - x.t || x.a.createdAt - y.a.createdAt || x.a.name.localeCompare(y.a.name));
      out.set(by, {
        by,
        at: now,
        rows: list.slice(0, LEADERBOARD_SIZE).map(({ a, v }, i) => ({
          rank: i + 1,
          name: a.name,
          value: v,
          lvl: a.level,
          class: a.cls,
          title: a.title,
          sprite: a.lookHash,
          ...(a.bot ? { bot: true as const } : {}),
        })),
      });
    }
    return out;
  }
}
