/**
 * The scout of director mode: fed every spectator message as it arrives (before the broadcast delay), it keeps the
 * interest increments of the `world` topic and where each agent is in real time. It is used for planning only and
 * never rendered: the director asks it, for the display time D, what each agent earns next, and which rooms to
 * subscribe to early so their detail is already in the delay line when the camera arrives.
 */
import type { InterestIncrement } from '@ajwf/shared';
import { isNum, isObj, isStr, parseIncrements } from './parse';

/** An increment and the server time of the batch that carried it. */
export type TimedIncrement = InterestIncrement & { ts: number };

export const FORESIGHT = {
  /** How far past the display time the interest looks. */
  aheadMs: 25_000,
  /** Weight of a moment at the far end of the lookahead, against 1 for one happening now (linear in between). */
  farWeight: 0.4,
  /** Half-life of the points already earned. */
  halfLifeMs: 45_000,
  /** Increments kept, back from the newest. */
  keepMs: 4 * 60_000,
  /** A single increment this large is a big moment... */
  bigPoints: 10,
  /** ...worth cutting to early when it is this close ahead of the display time. */
  bigAheadMs: 8_000,
};

/**
 * Interest of each agent at the display time D: the points they earn in (D, D + 25 s], nearer moments weighing more,
 * plus their recent points decayed with a half-life of 45 s. Increments are in server time.
 */
export function interestAt(incs: readonly TimedIncrement[], D: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const x of incs) {
    const dt = x.ts - D;
    if (dt > FORESIGHT.aheadMs) continue;
    const v =
      dt > 0
        ? x.p * (1 - (1 - FORESIGHT.farWeight) * (dt / FORESIGHT.aheadMs))
        : x.p * Math.pow(0.5, -dt / FORESIGHT.halfLifeMs);
    if (v > 0.01) out.set(x.n, (out.get(x.n) ?? 0) + v);
  }
  return out;
}

/** Big moments in (D, D + 8 s]: agent name -> their largest such increment. */
export function bigAhead(incs: readonly TimedIncrement[], D: number): Map<string, TimedIncrement> {
  const out = new Map<string, TimedIncrement>();
  for (const x of incs) {
    const dt = x.ts - D;
    if (dt <= 0 || dt > FORESIGHT.bigAheadMs || x.p < FORESIGHT.bigPoints) continue;
    const prev = out.get(x.n);
    if (!prev || x.p > prev.p) out.set(x.n, x);
  }
  return out;
}

export class Scout {
  private incs: TimedIncrement[] = [];
  private rooms = new Map<string, string>();
  /** Server clock minus local clock, from undelayed messages. */
  skew = 0;
  private seen = false;

  /** Every message, as it arrives. Never throws. */
  ingest(raw: unknown, localNow: number): void {
    if (!isObj(raw)) return;
    if (isNum(raw.now)) {
      this.skew = raw.now - localNow;
      this.seen = true;
    }
    if (raw.t === 'full' && raw.topic === 'world' && isObj(raw.data)) {
      if (isNum(raw.data.now)) this.skew = raw.data.now - localNow;
      this.rooms.clear();
      this.positions(raw.data.agents);
      return;
    }
    if (raw.t !== 'batch' || raw.topic !== 'world' || !isNum(raw.now)) return;
    const ts = raw.now;
    this.positions(raw.pos);
    if (Array.isArray(raw.gone)) for (const n of raw.gone) if (isStr(n)) this.rooms.delete(n);
    for (const x of parseIncrements(raw.interest)) {
      this.incs.push({ ...x, ts });
      this.rooms.set(x.n, x.r);
    }
    const cut = ts - FORESIGHT.keepMs;
    let i = 0;
    while (i < this.incs.length && this.incs[i]!.ts < cut) i++;
    if (i) this.incs.splice(0, i);
  }

  private positions(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const p of list) if (isObj(p) && isStr(p.n) && isStr(p.r)) this.rooms.set(p.n, p.r);
  }

  /** Whether any message came through yet. */
  get ready(): boolean {
    return this.seen;
  }

  /** Real (undelayed) server time. */
  realNow(localNow: number): number {
    return localNow + this.skew;
  }

  increments(): readonly TimedIncrement[] {
    return this.incs;
  }

  /** Where an agent is in real time, as far as the scout knows. */
  roomOf(name: string): string | undefined {
    return this.rooms.get(name);
  }

  /** The rooms (in real time) of the agents most interesting right now, for early subscriptions. */
  leaderRooms(localNow: number, max: number, except: ReadonlySet<string> = new Set()): string[] {
    const ranked = [...interestAt(this.incs, this.realNow(localNow))].sort((a, b) => b[1] - a[1]);
    const out: string[] = [];
    for (const [name] of ranked) {
      const room = this.rooms.get(name);
      if (!room || except.has(room) || out.includes(room)) continue;
      out.push(room);
      if (out.length >= max) break;
    }
    return out;
  }
}
