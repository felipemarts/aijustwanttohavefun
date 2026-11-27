import { own } from '@ajwf/shared';
import type { WorldState } from '@ajwf/engine';
import type { DailyStats, GameEvent } from '@ajwf/shared';

/** Daily numbers of the village. Pure: everything comes in as arguments. */

export const DAY_MS = 24 * 3_600_000;

/** UTC date of a timestamp, `YYYY-MM-DD`: the key of a gazette edition and of a stats row. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** First millisecond of a UTC date key. */
export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Newcomer names kept per day (the count goes on). */
const NEWCOMER_NAMES = 50;

/** Market volume of one item over a day. */
export type ItemVolume = { qty: number; gold: number; n: number };

/** What a day's public events add up to, for the gazette and the stats row. JSON-safe. */
export type DayTallyData = {
  date: string;
  /** Public event type -> count. */
  counts: Record<string, number>;
  newcomers: string[];
  newcomerCount: number;
  trades: Record<string, ItemVolume>;
  /** Sums of gold moved by type (bounties, thefts, embezzlement...). */
  gold: Record<string, number>;
  /** Projects that became available. */
  available: string[];
  /** Board posts tagged rumor. */
  rumors: number;
};

/** Accumulates one UTC day of public events. Feed it only events spectators may see. */
export class DayTally {
  readonly data: DayTallyData;

  constructor(date: string, data?: Partial<DayTallyData>) {
    this.data = { date, counts: {}, newcomers: [], newcomerCount: 0, trades: {}, gold: {}, available: [], rumors: 0, ...data };
  }

  get date(): string {
    return this.data.date;
  }

  count(type: string): number {
    return own(this.data.counts, type) ?? 0;
  }

  consume(ev: GameEvent, agentName: (id: string) => string | undefined): void {
    const d = this.data;
    d.counts[ev.type] = (own(d.counts, ev.type) ?? 0) + 1;
    const gold = ev.payload.gold;
    if (typeof gold === 'number' && gold > 0) d.gold[ev.type] = (own(d.gold, ev.type) ?? 0) + gold;
    if (ev.type === 'arrival' && ev.actor) {
      d.newcomerCount++;
      const name = agentName(ev.actor);
      if (name && d.newcomers.length < NEWCOMER_NAMES) d.newcomers.push(name);
    } else if (ev.type === 'project_available' && typeof ev.payload.project === 'string') {
      if (!d.available.includes(ev.payload.project)) d.available.push(ev.payload.project);
    } else if (ev.type === 'board_post' && ev.payload.tag === 'rumor') {
      d.rumors++;
    } else if (ev.type === 'market_trade') {
      const { item, qty, price } = ev.payload;
      if (typeof item === 'string' && typeof qty === 'number' && typeof price === 'number' && qty > 0) this.trade(item, qty, price);
    }
  }

  /** A market trade (also used to rebuild the day from stored trades after a restart). */
  trade(item: string, qty: number, price: number): void {
    let v = own(this.data.trades, item);
    if (!v) this.data.trades[item] = v = { qty: 0, gold: 0, n: 0 };
    v.qty += qty;
    v.gold += qty * price;
    v.n++;
  }

  tradeCount(): number {
    let n = 0;
    for (const v of Object.values(this.data.trades)) n += v.n;
    return n;
  }

  /** Average unit price per item, one decimal. */
  avgPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [item, v] of Object.entries(this.data.trades)) if (v.qty > 0) out[item] = Math.round((v.gold / v.qty) * 10) / 10;
    return out;
  }
}

/** Gold carried by active agents, held by guilds and in the village treasury. One pass over agents: run it daily. */
export function goldInCirculation(s: WorldState): number {
  let gold = s.village.treasury;
  for (const a of s.agents.values()) if (a.status === 'active') gold += a.gold;
  for (const g of s.guilds.values()) gold += g.treasury;
  return gold;
}

export type StatsInput = { population: number; onlinePeak: number; projectsDone: number; goldInCirculation: number; tally: DayTally };

export function dailyStats(o: StatsInput): DailyStats {
  return {
    date: o.tally.date,
    population: o.population,
    onlinePeak: o.onlinePeak,
    projects: o.projectsDone,
    projectsToday: o.tally.count('project_completed'),
    goldInCirculation: o.goldInCirculation,
    avgPrices: o.tally.avgPrices(),
    trades: o.tally.tradeCount(),
    newcomers: o.tally.data.newcomerCount,
  };
}
