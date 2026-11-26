import type { WorldState } from '@ajwf/engine';

/** An agent counts as online while it called the API within this window. */
export const ONLINE_WINDOW_MS = 15 * 60_000;
const COUNTS_CACHE_MS = 10_000;

export type Counts = { population: number; byClass: Record<string, number> };

/**
 * Head counts for the public pages. Population is a scan of every agent, so it is cached for a few seconds;
 * presence (agent id -> last authenticated request) is swept as it is counted.
 */
export class Census {
  /** agent id -> last authenticated request. */
  readonly presence = new Map<string, number>();
  private cached: Counts & { at: number } = { at: -Infinity, population: 0, byClass: {} };

  constructor(private state: WorldState) {}

  seen(agentId: string, now: number): void {
    // Re-inserted so the map stays ordered by last request and the sweep can stop at the first fresh entry.
    this.presence.delete(agentId);
    this.presence.set(agentId, now);
  }

  online(now: number): number {
    for (const [id, at] of this.presence) {
      if (now - at < ONLINE_WINDOW_MS) break;
      this.presence.delete(id);
    }
    return this.presence.size;
  }

  counts(now: number): Counts {
    if (now - this.cached.at > COUNTS_CACHE_MS) {
      let population = 0;
      const byClass: Record<string, number> = {};
      for (const a of this.state.agents.values()) {
        if (a.status !== 'active') continue;
        population++;
        byClass[a.cls] = (byClass[a.cls] ?? 0) + 1;
      }
      this.cached = { at: now, population, byClass };
    }
    return { population: this.cached.population, byClass: { ...this.cached.byClass } };
  }
}
