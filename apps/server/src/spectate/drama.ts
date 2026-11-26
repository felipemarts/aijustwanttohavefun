import { SPECTATE } from './constants';

/** Exponential decay: what remains of `value` after `elapsedMs` with the given half-life. */
export function decay(value: number, elapsedMs: number, halfLifeMs: number = SPECTATE.dramaHalfLifeMs): number {
  if (elapsedMs <= 0) return value;
  return value * Math.pow(2, -elapsedMs / halfLifeMs);
}

type Score = { v: number; at: number };

/**
 * Drama score per room for director mode (§14.1): each broadcast event adds its `drama`; scores decay with a
 * half-life, computed lazily when read or bumped, so nothing runs while the world is quiet.
 */
export class DramaBoard {
  private scores = new Map<string, Score>();

  constructor(
    private readonly halfLifeMs: number = SPECTATE.dramaHalfLifeMs,
    private readonly floor: number = SPECTATE.dramaFloor,
  ) {}

  add(room: string, drama: number, now: number): void {
    const s = this.scores.get(room);
    if (!s) this.scores.set(room, { v: drama, at: now });
    else {
      s.v = decay(s.v, now - s.at, this.halfLifeMs) + drama;
      s.at = now;
    }
  }

  score(room: string, now: number): number {
    const s = this.scores.get(room);
    return s ? decay(s.v, now - s.at, this.halfLifeMs) : 0;
  }

  /** The `n` hottest rooms, room id -> score rounded to 0.1. Forgets rooms that cooled down. */
  top(n: number, now: number): Record<string, number> {
    const live: [string, number][] = [];
    for (const [room, s] of this.scores) {
      const v = decay(s.v, now - s.at, this.halfLifeMs);
      if (v < this.floor) this.scores.delete(room);
      else live.push([room, v]);
    }
    live.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(live.slice(0, n).map(([room, v]) => [room, Math.round(v * 10) / 10]));
  }
}
