/**
 * What the simulation measures, and the report it writes. Everything is derived from action results, the events
 * the engine emits and periodic samples of the world, never from changes to engine code.
 */
import { apCost, refreshResource, spawnSlots, xpToNext, BALANCE, type ActionResult } from '@ajwf/engine';
import type { ActionName, GameEvent } from '@ajwf/shared';
import { PROFILES } from '../profiles';
import { PROFILE_IDS, type ProfileId } from '../profiles/types';
import type { SimBot, SimOptions, Simulation } from './runner';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REPORT_LEVELS = [2, 3, 5, 8, 10, 12, 15, 18, 20] as const;
/** Goods whose market price the report follows. */
export const KEY_GOODS = ['minor_potion', 'coal', 'flask', 'iron_ingot', 'oil', 'buckle', 'bread', 'green_dye', 'cos_chef_hat', 'padded_armor'];
/** Zones near the village whose monsters and resources the report samples (the crowd's daily bread). */
const NEAR_ZONES = ['forest', 'hills', 'mines'];

const CUM_XP: number[] = [0];
for (let l = 1; l <= BALANCE.maxLevel; l++) CUM_XP[l] = CUM_XP[l - 1]! + (l > 1 ? xpToNext(l - 1) : 0);
/** Total XP ever earned by an agent at this level and XP. */
export const totalXp = (level: number, xp: number): number => CUM_XP[level]! + xp;

function xpSource(action: string): string {
  if (action === 'attack' || action === 'cast' || action === 'taunt' || action === 'flee') return 'combat';
  if (action === 'quest_turn_in') return 'quests';
  if (action === 'gather') return 'gather';
  if (action === 'craft') return 'craft';
  return action;
}

export type Group = 'solo' | 'grouped' | 'other';
/** The M4 comparison: fighters hunt alone, socials (and traitors) in parties. The rest have other jobs. */
export function groupOf(p: ProfileId): Group {
  if (p === 'fighter') return 'solo';
  return PROFILES[p].grouped ? 'grouped' : 'other';
}

type Sample = {
  t: number;
  avgGold: number;
  medianGold: number;
  /** All gold in agents' purses, guild treasuries and the village treasury, per agent. */
  supplyPerAgent: number;
  treasury: number;
  avgLevel: Record<Group, number>;
  /** Share of daytime monster slots alive in the zones near the village. */
  monstersAlive: number;
  /** Share of resource stock left in those zones. */
  resourcesLeft: number;
  parties: number;
};

type BotStats = { levelAt: number[]; xp: Record<string, number>; ap: number; apBy: Record<string, number>; deaths: number; refusals: number; actions: number; sessions: number };

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
const inc = (m: Record<string, number>, k: string, n = 1) => void (m[k] = (m[k] ?? 0) + n);
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

export class Metrics {
  private stats: BotStats[] = [];
  private supply = 0;
  private nextSample: number;
  readonly samples: Sample[] = [];
  readonly refusals: Record<string, number> = {};
  readonly refusalsBy: Record<string, number> = {};
  readonly actionsBy: Record<string, number> = {};
  readonly apBy: Record<string, number> = {};
  readonly xpBy: Record<string, number> = {};
  readonly gold: Record<string, number> = {};
  readonly quests: Record<string, number> = {};
  readonly deaths: Record<string, number> = {};
  private waits = 0;
  private sessions = 0;
  private parties = new Map<string, { start: number; end?: number; size: number }>();
  private guaranteed = 0;
  private market = { trades: 0, units: 0, gold: 0 };
  private prices = new Map<string, Map<number, { units: number; gold: number }>>();
  private projects: { id: string; t: number }[] = [];
  private elections: { n: number; t: number; voters: number; eligible: number; candidates: number; winner: string | null }[] = [];
  private civic: Record<string, number> = {};
  /** Grouped bots' attacks and casts, and how many of them had a party mate standing in the room. */
  private groupedBlows = { all: 0, withMate: 0, inParty: 0 };

  constructor(
    private sim: Simulation,
    private opt: SimOptions,
  ) {
    this.nextSample = opt.start;
  }

  private st(bot: SimBot): BotStats {
    let s = this.stats[bot.idx];
    if (!s) this.stats[bot.idx] = s = { levelAt: [], xp: {}, ap: 0, apBy: {}, deaths: 0, refusals: 0, actions: 0, sessions: 0 };
    return s;
  }

  private moneySupply(): number {
    const s = this.sim.s;
    let n = s.village.treasury;
    for (const a of s.agents.values()) n += a.gold;
    for (const g of s.guilds.values()) n += g.treasury;
    return n;
  }

  /** Called before each wake-up: takes the hourly samples that are due. */
  advance(now: number): void {
    if (!this.samples.length && !this.supply) this.supply = this.moneySupply();
    while (this.nextSample <= now) {
      this.sample(this.nextSample);
      this.nextSample += this.opt.sampleEveryMs;
    }
  }

  /** Pauses by profile and kind (`ap`: out of AP, `short`/`long` otherwise) and where they happened. */
  readonly pauses: Record<string, number> = {};
  readonly pauseRooms: Record<string, number> = {};

  onWait(bot: SimBot, ms: number): void {
    this.waits++;
    const a = this.sim.s.agents.get(bot.id)!;
    const kind = a.ap < 2 ? 'ap' : ms <= this.opt.maxPauseMs ? 'short' : 'long';
    inc(this.pauses, `${bot.profile}:${kind}`);
    inc(this.pauseRooms, `${bot.profile}:${a.room}`);
  }

  onSession(bot: SimBot, _actions: number): void {
    this.sessions++;
    this.st(bot).sessions++;
  }

  beforeAction(bot: SimBot): { xp: number } {
    const a = this.sim.s.agents.get(bot.id)!;
    return { xp: totalXp(a.level, a.xp) };
  }

  afterAction(bot: SimBot, action: string, _params: Record<string, unknown>, res: ActionResult, events: GameEvent[], before: { xp: number }): void {
    const st = this.st(bot);
    st.actions++;
    inc(this.actionsBy, action);
    if (!res.ok) {
      st.refusals++;
      inc(this.refusals, res.error.code);
      inc(this.refusalsBy, `${action}:${res.error.code}:${res.error.msg.k}`);
    } else {
      const ap = apCost(action as ActionName);
      st.ap += ap;
      if (ap) inc(st.apBy, xpSource(action), ap);
      inc(this.apBy, xpSource(action), ap);
      if (action.startsWith('mayor_') || action === 'run_for_mayor' || action === 'vote' || action === 'contribute' || action.startsWith('guild_')) inc(this.civic, action);
    }
    const a = this.sim.s.agents.get(bot.id)!;
    if ((action === 'attack' || action === 'cast') && res.ok && groupOf(bot.profile) === 'grouped') {
      this.groupedBlows.all++;
      const party = a.party ? this.sim.s.parties.get(a.party) : undefined;
      if (party && party.members.length > 1) {
        this.groupedBlows.inParty++;
        if (party.members.some((id) => id !== a.id && this.sim.s.agents.get(id)?.room === a.room)) this.groupedBlows.withMate++;
      }
    }
    const dx = totalXp(a.level, a.xp) - before.xp;
    if (dx > 0) {
      inc(st.xp, xpSource(action), dx);
      inc(this.xpBy, xpSource(action), dx);
    }
    const supply = this.moneySupply();
    const dg = supply - this.supply;
    this.supply = supply;
    if (dg) inc(this.gold, action === 'attack' || action === 'cast' ? 'combat' : action, dg);
    this.onEvents(events, action);
  }

  /** Engine events, from actions and ticks. */
  onEvents(events: GameEvent[], cause: string): void {
    for (const ev of events) {
      const bot = this.sim.botOf(ev.actor);
      const p = ev.payload as Record<string, unknown> & { m?: { p?: Record<string, number> } };
      switch (ev.type) {
        case 'level_up':
          if (bot) {
            const lvl = Number(p.level);
            const st = this.st(bot);
            if (st.levelAt[lvl] === undefined) st.levelAt[lvl] = ev.ts - bot.joinedAt;
          }
          break;
        case 'kill_share':
          if (bot && p.m?.p?.xp) {
            inc(this.st(bot).xp, 'shared kills', p.m.p.xp);
            inc(this.xpBy, 'shared kills', p.m.p.xp);
          }
          break;
        case 'fallen':
          if (bot) {
            this.st(bot).deaths++;
            inc(this.deaths, bot.profile);
          }
          break;
        case 'respawn':
          // Waking at the temple costs gold; inside an action the supply delta already counted it.
          if (cause === 'tick' && typeof p.lost === 'number' && p.lost > 0) {
            inc(this.gold, 'death (timer)', -p.lost);
            this.supply -= p.lost;
          }
          break;
        case 'quest_done':
          inc(this.quests, String(p.kind));
          break;
        case 'party_join': {
          const id = String(ev.target);
          const rec = this.parties.get(id) ?? { start: ev.ts, size: 1 };
          rec.size = Math.max(rec.size, Number((p.m?.p as Record<string, number> | undefined)?.n ?? 2));
          this.parties.set(id, rec);
          break;
        }
        case 'trade':
          this.guaranteed++;
          break;
        case 'market_trade': {
          const item = String(p.item);
          const qty = Number(p.qty);
          const price = Number(p.price);
          this.market.trades++;
          this.market.units += qty;
          this.market.gold += qty * price;
          const day = Math.floor((ev.ts - this.opt.start) / DAY);
          let byDay = this.prices.get(item);
          if (!byDay) this.prices.set(item, (byDay = new Map()));
          const d = byDay.get(day) ?? { units: 0, gold: 0 };
          d.units += qty;
          d.gold += qty * price;
          byDay.set(day, d);
          break;
        }
        case 'project_completed':
          this.projects.push({ id: String(p.project), t: ev.ts });
          break;
        case 'election_result': {
          const s = this.sim.s;
          let eligible = 0;
          for (const ag of s.agents.values()) if (ag.status === 'active' && ag.claimed && ag.level >= BALANCE.election.voteLevel) eligible++;
          this.elections.push({ n: Number(p.n), t: ev.ts, voters: Number(p.voters ?? 0), eligible, candidates: ((p.votes as unknown[]) ?? []).length, winner: (p.winner as string | null) ?? null });
          break;
        }
      }
    }
  }

  private sample(t: number): void {
    const s = this.sim.s;
    const c = s.content;
    const golds: number[] = [];
    const lv: Record<Group, number[]> = { solo: [], grouped: [], other: [] };
    for (const bot of this.sim.bots) {
      const a = s.agents.get(bot.id)!;
      golds.push(a.gold);
      lv[groupOf(bot.profile)].push(a.level);
    }
    let slots = 0;
    let alive = 0;
    let stock = 0;
    let cap = 0;
    for (const room of c.rooms.values()) {
      if (!NEAR_ZONES.includes(room.zone)) continue;
      const day = spawnSlots(c, room.id).filter((x) => !x.night).length;
      slots += day;
      const nightSlots = new Set(spawnSlots(c, room.id).flatMap((x, i) => (x.night ? [i] : [])));
      alive += s.rooms.get(room.id)!.monsters.filter((m) => !nightSlots.has(m.slot)).length;
      for (const r of room.resources) {
        stock += refreshResource(s, room.id, r.id, t)?.qty ?? 0;
        cap += r.max;
      }
    }
    for (const [id, rec] of this.parties) if (rec.end === undefined && !s.parties.has(id)) rec.end = t;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    this.samples.push({
      t,
      avgGold: round(avg(golds)),
      medianGold: median(golds),
      supplyPerAgent: round(this.moneySupply() / Math.max(1, this.sim.bots.length)),
      treasury: s.village.treasury,
      avgLevel: { solo: round(avg(lv.solo), 2), grouped: round(avg(lv.grouped), 2), other: round(avg(lv.other), 2) },
      monstersAlive: round(slots ? alive / slots : 0, 3),
      resourcesLeft: round(cap ? stock / cap : 0, 3),
      parties: s.parties.size,
    });
  }

  progressLine(now: number, wallMs: number): string {
    const day = (now - this.opt.start) / DAY;
    const last = this.samples[this.samples.length - 1];
    const lv = last?.avgLevel;
    return `day ${day.toFixed(0)}: ${this.sim.actions} actions, ${(this.sim.actions / Math.max(0.001, wallMs / 1000)).toFixed(0)} act/s, avg level solo ${lv?.solo} grouped ${lv?.grouped} other ${lv?.other}, avg gold ${last?.avgGold}, projects ${this.projects.length}`;
  }

  report(now: number, wallSeconds: number): SimReport {
    const s = this.sim.s;
    const opt = this.opt;
    const bots = this.sim.bots;
    const hours = (now - opt.start) / HOUR;
    this.sample(now);

    /** Hours for half of a population to reach a level (non-reachers count as never), and the share that did. */
    const levelTimes = (pop: SimBot[]) => {
      const out: Record<number, { p50Hours: number | null; reached: number }> = {};
      for (const L of REPORT_LEVELS) {
        const times = pop.map((b) => this.st(b).levelAt[L] ?? Infinity).sort((a, b) => a - b);
        const mid = times[Math.floor(pop.length / 2)];
        out[L] = { p50Hours: mid !== undefined && Number.isFinite(mid) ? round(mid / HOUR) : null, reached: round(times.filter(Number.isFinite).length / Math.max(1, pop.length), 3) };
      }
      return out;
    };
    const byGroup = (g: Group) => bots.filter((b) => groupOf(b.profile) === g);
    const xpAp = (pop: SimBot[]) => {
      let xp = 0;
      let ap = 0;
      for (const b of pop) {
        const st = this.st(b);
        xp += Object.values(st.xp).reduce((a, v) => a + v, 0);
        ap += st.ap;
      }
      const apBy: Record<string, number> = {};
      const xpBy: Record<string, number> = {};
      for (const b of pop) {
        for (const [k, n] of Object.entries(this.st(b).apBy)) inc(apBy, k, n);
        for (const [k, n] of Object.entries(this.st(b).xp)) inc(xpBy, k, n);
      }
      return { xp, ap, xpPerAp: round(ap ? xp / ap : 0, 2), apShare: Object.fromEntries(Object.entries(apBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, round(n / Math.max(1, ap), 3)])), xpBySource: xpBy };
    };
    const levelsOf = (pop: SimBot[]) => pop.map((b) => s.agents.get(b.id)!.level);
    const summary = (pop: SimBot[]) => {
      const lv = levelsOf(pop);
      return {
        n: pop.length,
        avgLevel: round(lv.reduce((a, b) => a + b, 0) / Math.max(1, lv.length), 2),
        medianLevel: median(lv),
        maxLevel: Math.max(0, ...lv),
        deaths: pop.reduce((n, b) => n + this.st(b).deaths, 0),
        refusalRate: round(pop.reduce((n, b) => n + this.st(b).refusals, 0) / Math.max(1, pop.reduce((n, b) => n + this.st(b).actions, 0)), 4),
        ...xpAp(pop),
        levels: levelTimes(pop),
      };
    };

    const solo = summary(byGroup('solo'));
    const grouped = summary(byGroup('grouped'));
    // The highest level that half of both populations reached: compare the time it took each.
    let ratio: SimReport['ratio'] = null;
    for (const L of [...REPORT_LEVELS].reverse()) {
      const a = solo.levels[L]?.p50Hours;
      const b = grouped.levels[L]?.p50Hours;
      if (a && b) {
        ratio = { level: L, soloHours: a, groupedHours: b, ratio: round(a / b, 2) };
        break;
      }
    }

    const byProfile = Object.fromEntries(PROFILE_IDS.map((p) => [p, summary(bots.filter((b) => b.profile === p))]).filter(([, v]) => (v as { n: number }).n > 0));
    const byCadence = Object.fromEntries(
      opt.cadence.map((c) => {
        const all = bots.filter((b) => b.cadence.id === c.id);
        const pick = (lt: ReturnType<typeof levelTimes>) => Object.fromEntries([5, 10, 15, 20].map((L) => [L, lt[L]?.p50Hours ?? null]));
        const lv = (pop: SimBot[]) => round(levelsOf(pop).reduce((a, b) => a + b, 0) / Math.max(1, pop.length), 2);
        const solo = all.filter((b) => groupOf(b.profile) === 'solo');
        const grp = all.filter((b) => groupOf(b.profile) === 'grouped');
        return [
          c.id,
          {
            n: all.length,
            avgLevel: lv(all),
            soloLevel: lv(solo),
            groupedLevel: lv(grp),
            apPerDay: round(all.reduce((n, b) => n + this.st(b).ap, 0) / Math.max(1, all.length) / Math.max(1e-9, hours / 24)),
            soloHours: pick(levelTimes(solo)),
            groupedHours: pick(levelTimes(grp)),
          },
        ];
      }),
    );

    // Gold over time, per simulated day (the last sample of each day).
    const days: SimReport['gold']['daily'] = [];
    for (const smp of this.samples) {
      const d = Math.floor((smp.t - opt.start) / DAY);
      const row = { day: d, avg: smp.avgGold, median: smp.medianGold, supplyPerAgent: smp.supplyPerAgent, treasury: smp.treasury };
      if (days.length && days[days.length - 1]!.day === d) days[days.length - 1] = row;
      else days.push(row);
    }
    const sources = Object.fromEntries(Object.entries(this.gold).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]));
    const sinks = Object.fromEntries(Object.entries(this.gold).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]));
    const tail = days.slice(-4);
    const growth = tail.length >= 2 && tail[0]!.supplyPerAgent > 0 ? (tail[tail.length - 1]!.supplyPerAgent / tail[0]!.supplyPerAgent) ** (1 / (tail.length - 1)) - 1 : 0;

    const lifetimes = [...this.parties.values()].map((p) => ((p.end ?? now) - p.start) / HOUR);
    const prices = Object.fromEntries(
      KEY_GOODS.filter((g) => this.prices.has(g)).map((g) => [g, [...this.prices.get(g)!].sort((a, b) => a[0] - b[0]).map(([day, d]) => ({ day, avg: round(d.gold / d.units, 1), units: d.units }))]),
    );
    const totalRefusals = Object.values(this.refusals).reduce((a, b) => a + b, 0);
    const nearSamples = this.samples.slice(Math.min(this.samples.length - 1, 6));

    return {
      config: { bots: opt.bots, actions: opt.actions ?? null, days: opt.days ?? null, seed: opt.seed, mix: opt.mix, cadence: opt.cadence, thinkMs: opt.thinkMs, maxPauseMs: opt.maxPauseMs },
      sim: { actions: this.sim.actions, waits: this.waits, sessions: this.sessions, simulatedHours: round(hours), simulatedDays: round(hours / 24, 2), wallSeconds: round(wallSeconds, 1), actionsPerSecond: Math.round(this.sim.actions / Math.max(0.001, wallSeconds)) },
      solo,
      grouped,
      ratio,
      byProfile,
      byCadence,
      xp: { bySource: Object.fromEntries(Object.entries(this.xpBy).sort((a, b) => b[1] - a[1])), apBySource: this.apBy, perApBySource: Object.fromEntries(Object.entries(this.xpBy).filter(([k]) => this.apBy[k]).map(([k, v]) => [k, round(v / this.apBy[k]!, 2)])) },
      gold: { daily: days, sources, sinks, net: Object.values(this.gold).reduce((a, b) => a + b, 0), supplyGrowthPerDay: round(growth, 4) },
      deaths: this.deaths,
      quests: this.quests,
      parties: {
        blowsInParty: round(this.groupedBlows.inParty / Math.max(1, this.groupedBlows.all), 3),
        blowsWithMate: round(this.groupedBlows.withMate / Math.max(1, this.groupedBlows.all), 3),
        formed: this.parties.size, activeAtEnd: s.parties.size, avgLifetimeHours: round(lifetimes.reduce((a, b) => a + b, 0) / Math.max(1, lifetimes.length)), medianLifetimeHours: round(median(lifetimes)), avgMaxSize: round([...this.parties.values()].reduce((a, p) => a + p.size, 0) / Math.max(1, this.parties.size), 2) },
      trades: { guaranteed: this.guaranteed, market: this.market, prices },
      civic: { actions: this.civic, projects: this.projects.map((p) => ({ id: p.id, day: round((p.t - opt.start) / DAY, 2) })), projectsPerDay: round(this.projects.length / Math.max(1e-9, hours / 24), 2), elections: this.elections.map((e) => ({ ...e, day: round((e.t - opt.start) / DAY, 2), turnout: round(e.voters / Math.max(1, e.eligible), 3) })), treasury: s.village.treasury, mayor: s.village.mayor?.name ?? null, candidates: s.village.election.candidates.length, votesNow: Object.keys(s.village.election.votes).length },
      refusals: { total: totalRefusals, rate: round(totalRefusals / Math.max(1, this.sim.actions), 4), byCode: Object.fromEntries(Object.entries(this.refusals).sort((a, b) => b[1] - a[1])), top: Object.fromEntries(Object.entries(this.refusalsBy).sort((a, b) => b[1] - a[1]).slice(0, 15)) },
      world: {
        monstersAliveNearVillage: round(nearSamples.reduce((a, x) => a + x.monstersAlive, 0) / Math.max(1, nearSamples.length), 3),
        resourcesLeftNearVillage: round(nearSamples.reduce((a, x) => a + x.resourcesLeft, 0) / Math.max(1, nearSamples.length), 3),
        waitShare: round(this.waits / Math.max(1, this.waits + this.sim.actions), 3),
        pauses: Object.fromEntries(Object.entries(this.pauses).sort((a, b) => b[1] - a[1])),
        pauseRooms: Object.fromEntries(Object.entries(this.pauseRooms).sort((a, b) => b[1] - a[1]).slice(0, 15)),
      },
      actions: Object.fromEntries(Object.entries(this.actionsBy).sort((a, b) => b[1] - a[1])),
      samples: this.samples,
    };
  }
}

type PopSummary = {
  n: number;
  avgLevel: number;
  medianLevel: number;
  maxLevel: number;
  deaths: number;
  refusalRate: number;
  xp: number;
  ap: number;
  xpPerAp: number;
  apShare: Record<string, number>;
  xpBySource: Record<string, number>;
  levels: Record<number, { p50Hours: number | null; reached: number }>;
};

export type SimReport = {
  config: Record<string, unknown>;
  sim: { actions: number; waits: number; sessions: number; simulatedHours: number; simulatedDays: number; wallSeconds: number; actionsPerSecond: number };
  solo: PopSummary;
  grouped: PopSummary;
  ratio: { level: number; soloHours: number; groupedHours: number; ratio: number } | null;
  byProfile: Record<string, PopSummary>;
  byCadence: Record<string, { n: number; avgLevel: number; soloLevel: number; groupedLevel: number; apPerDay: number; soloHours: Record<number, number | null>; groupedHours: Record<number, number | null> }>;
  xp: { bySource: Record<string, number>; apBySource: Record<string, number>; perApBySource: Record<string, number> };
  gold: { daily: { day: number; avg: number; median: number; supplyPerAgent: number; treasury: number }[]; sources: Record<string, number>; sinks: Record<string, number>; net: number; supplyGrowthPerDay: number };
  deaths: Record<string, number>;
  quests: Record<string, number>;
  parties: { blowsInParty: number; blowsWithMate: number; formed: number; activeAtEnd: number; avgLifetimeHours: number; medianLifetimeHours: number; avgMaxSize: number };
  trades: { guaranteed: number; market: { trades: number; units: number; gold: number }; prices: Record<string, { day: number; avg: number; units: number }[]> };
  civic: {
    actions: Record<string, number>;
    projects: { id: string; day: number }[];
    projectsPerDay: number;
    elections: { n: number; day: number; voters: number; eligible: number; turnout: number; candidates: number; winner: string | null }[];
    treasury: number;
    mayor: string | null;
    candidates: number;
    votesNow: number;
  };
  refusals: { total: number; rate: number; byCode: Record<string, number>; top: Record<string, number> };
  world: { monstersAliveNearVillage: number; resourcesLeftNearVillage: number; waitShare: number; pauses: Record<string, number>; pauseRooms: Record<string, number> };
  actions: Record<string, number>;
  samples: Sample[];
};
