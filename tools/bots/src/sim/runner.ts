/**
 * In-process balance simulation (PLANEJAMENTO §16.4): hundreds of scripted bots play one world through
 * `applyAction` and `tick` only, on a fake clock. Deterministic for a seed; no server, no database.
 *
 * Time is modelled the way LLM agents play: each bot wakes up for a session every so often (its cadence), takes up
 * to a number of actions a few seconds apart, and sleeps again when the session is over, when it runs out of AP or
 * when it has nothing to do but wait. The world clock only moves forward: wake-ups from every bot are processed in
 * time order and `tick` runs before each one.
 */
import { randomAppearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import { loadContent } from '@ajwf/content/node';
import { applyAction, checkInvariants, createWorld, eventsSince, observe, questView, registerAgent, tick, villageView, type WorldState } from '@ajwf/engine';
import { CLASSES, createRng, TEXT_EVENT_TYPES, type ClassId, type LaunchLanguage, type Rng } from '@ajwf/shared';
import { nameGenerator } from '../names';
import { PROFILES } from '../profiles';
import { newBotMem, PROFILE_IDS, type AgentView, type BotMem, type InboxMsg, type LastResult, type ProfileId, type QuestView } from '../profiles/types';
import { WakeHeap } from './heap';
import { Metrics, type SimReport } from './metrics';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A cadence bucket: how often agents of this kind wake up, and how many actions a session takes at most. */
export type Cadence = { id: string; everyMs: number; actions: number; weight: number };

/**
 * Default behaviour model. Agents are LLMs woken by a scheduler, from every 30 minutes to twice a day. A session
 * takes up to 40 actions; agents that wake less often run longer sessions (about what their AP allows plus some
 * talk), so AP, not the session length, is what caps a session. Twice-a-day agents still lose the AP regenerated
 * beyond the 240 cap while asleep.
 */
export const DEFAULT_CADENCE: Cadence[] = [
  { id: '30m', everyMs: 30 * MIN, actions: 40, weight: 0.15 },
  { id: '1h', everyMs: HOUR, actions: 40, weight: 0.25 },
  { id: '2h', everyMs: 2 * HOUR, actions: 80, weight: 0.3 },
  { id: '4h', everyMs: 4 * HOUR, actions: 150, weight: 0.2 },
  { id: '12h', everyMs: 12 * HOUR, actions: 300, weight: 0.1 },
];

export const DEFAULT_MIX: Record<ProfileId, number> = { explorer: 0.12, fighter: 0.25, social: 0.3, trader: 0.13, politician: 0.1, traitor: 0.1 };

export type SimOptions = {
  bots: number;
  /** Stop after this many actions (default 500,000) ... */
  actions?: number;
  /** ... or after this many simulated days, whichever comes first. */
  days?: number;
  seed: number;
  mix: Record<ProfileId, number>;
  cadence: Cadence[];
  /** Time between two actions of a session (LLM latency), uniform in this range. */
  thinkMs: [number, number];
  /** A bot asked to wait at most this long stays in its session (a short pause); longer waits end it. */
  maxPauseMs: number;
  /** Run `checkInvariants` every this many actions (and at the end). */
  invariantsEvery: number;
  /** Interval of the time series in the report. */
  sampleEveryMs: number;
  start: number;
  progress?: (line: string) => void;
};

export function defaultOptions(over: Partial<SimOptions> = {}): SimOptions {
  return {
    bots: 500,
    actions: 500_000,
    seed: 1,
    mix: DEFAULT_MIX,
    cadence: DEFAULT_CADENCE,
    thinkMs: [3_000, 8_000],
    maxPauseMs: 90_000,
    invariantsEvery: 25_000,
    sampleEveryMs: HOUR,
    start: Date.UTC(2026, 0, 5, 8),
    ...over,
  };
}

export type SimBot = {
  idx: number;
  id: string;
  name: string;
  profile: ProfileId;
  cls: ClassId;
  lang: LaunchLanguage;
  cadence: Cadence;
  mem: BotMem;
  rng: Rng;
  seed: number;
  cursor: number;
  last: LastResult | null;
  joinedAt: number;
  sessionStart: number;
  sessionActions: number;
  sessionTurns: number;
};

/** Splits `n` into whole counts proportional to the weights (largest remainders), deterministically. */
export function apportion<K extends string>(n: number, weights: Record<K, number>): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const total = keys.reduce((s, k) => s + weights[k], 0);
  const out = {} as Record<K, number>;
  const rem: [K, number][] = [];
  let used = 0;
  for (const k of keys) {
    const exact = (n * weights[k]) / total;
    out[k] = Math.floor(exact);
    used += out[k];
    rem.push([k, exact - out[k]]);
  }
  rem.sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < n - used; i++) out[rem[i % rem.length]![0]]++;
  return out;
}

/** Builds what a bot may read: observation, `/me` data, new inbox messages, its last answer, `/village` on demand. */
function viewOf(s: WorldState, bot: SimBot, now: number, rng: Rng): AgentView {
  const ctx = { now, rng };
  const obs = observe(s, bot.id, ctx);
  const a = s.agents.get(bot.id)!;
  const c = s.content;
  const cls = c.classes.get(a.cls)!;
  const { events, cursor } = eventsSince(s, bot.id, bot.cursor, 50);
  bot.cursor = cursor;
  const inbox: InboxMsg[] = events.map((ev) =>
    TEXT_EVENT_TYPES.has(ev.type)
      ? { kind: ev.type, from: (ev.actor && s.agents.get(ev.actor)?.name) || '?', text: String(ev.payload.text ?? '') }
      : { kind: ev.type },
  );
  return {
    obs,
    inv: {
      items: { ...a.inv },
      equipped: { ...a.equip },
      skills: cls.skills.map((id) => c.skills.get(id)!).map((sk) => ({ id: sk.id, mp: sk.mp, level: sk.level, known: a.level >= sk.level })),
    },
    now,
    name: a.name,
    cls: a.cls,
    profession: a.profession,
    quests: Object.keys(a.quests)
      .map((id) => c.quests.get(id))
      .filter((q) => !!q)
      .map((q) => questView(a, q) as unknown as QuestView),
    inbox,
    last: bot.last,
    village: () => villageView(s, now),
  };
}

export class Simulation {
  readonly content: Content;
  readonly s: WorldState;
  readonly bots: SimBot[] = [];
  readonly metrics: Metrics;
  readonly rng: Rng;
  private heap = new WakeHeap();
  private byAgent = new Map<string, SimBot>();
  now: number;
  actions = 0;

  constructor(readonly opt: SimOptions) {
    this.content = loadContent();
    this.now = opt.start;
    this.s = createWorld(this.content, opt.start);
    this.rng = createRng(opt.seed);
    this.metrics = new Metrics(this, opt);
    this.populate();
  }

  private populate(): void {
    const { opt, s } = this;
    const setup = createRng(opt.seed * 7919 + 13);
    const names = nameGenerator(setup);
    const counts = apportion(opt.bots, opt.mix);
    const buckets = Object.fromEntries(opt.cadence.map((c) => [c.id, c.weight])) as Record<string, number>;
    const langs: LaunchLanguage[] = ['en', 'pt-BR', 'es', 'fr', 'ja', 'zh-CN'];
    let idx = 0;
    for (const profile of PROFILE_IDS) {
      const n = counts[profile] ?? 0;
      if (!n) continue;
      // Cadences and classes are spread evenly inside each profile, so profiles compare on the same footing.
      const per = apportion(n, buckets);
      const order: Cadence[] = [];
      for (const c of opt.cadence) for (let k = 0; k < (per[c.id] ?? 0); k++) order.push(c);
      for (let k = 0; k < n; k++) {
        const cls = CLASSES[k % CLASSES.length]!;
        const cadence = order[(k * 7) % order.length]!;
        const lang = langs[idx % langs.length]!;
        const reg = registerAgent(s, { name: names(), cls, lang, appearance: randomAppearance(setup), claimed: true, bot: true }, { now: opt.start, rng: this.rng });
        if (!reg.ok) throw new Error(`register failed: ${reg.error.code}`);
        const seed = opt.seed * 100_003 + idx;
        // First wake-up somewhere in the first interval: agents do not all arrive at once.
        const first = opt.start + Math.floor(setup.next() * cadence.everyMs);
        const bot: SimBot = {
          idx,
          id: reg.agent.id,
          name: reg.agent.name,
          profile,
          cls,
          lang,
          cadence,
          mem: newBotMem(),
          rng: createRng(seed),
          seed,
          cursor: s.meta.eventSeq,
          last: null,
          joinedAt: first,
          sessionStart: first,
          sessionActions: 0,
          sessionTurns: 0,
        };
        this.bots.push(bot);
        this.byAgent.set(bot.id, bot);
        this.heap.push(first, idx);
        idx++;
      }
    }
  }

  botOf(agentId: string | undefined): SimBot | undefined {
    return agentId ? this.byAgent.get(agentId) : undefined;
  }

  /** Runs until the action budget or the simulated time is used up. Throws on an invariant violation. */
  run(): SimReport {
    const { opt } = this;
    const end = opt.days !== undefined ? opt.start + opt.days * 24 * HOUR : Infinity;
    const budget = opt.actions ?? Infinity;
    const wallStart = performance.now();
    let nextCheck = opt.invariantsEvery;
    let nextProgress = opt.start + 24 * HOUR;
    while (this.heap.size && this.actions < budget) {
      if (this.heap.peekTime() > end) break;
      const ev = this.heap.pop()!;
      this.now = ev.time;
      this.metrics.advance(this.now);
      const tickEvents = tick(this.s, { now: this.now, rng: this.rng });
      if (tickEvents.length) this.metrics.onEvents(tickEvents, 'tick');
      this.step(this.bots[ev.bot]!);
      if (this.actions >= nextCheck) {
        nextCheck += opt.invariantsEvery;
        this.checkInvariants();
      }
      if (opt.progress && this.now >= nextProgress) {
        nextProgress += 24 * HOUR;
        opt.progress(this.metrics.progressLine(this.now, performance.now() - wallStart));
      }
    }
    this.checkInvariants();
    return this.metrics.report(this.now, (performance.now() - wallStart) / 1000);
  }

  private checkInvariants(): void {
    const v = checkInvariants(this.s, this.now);
    if (v.length) throw new Error(`invariant violated after ${this.actions} actions at ${new Date(this.now).toISOString()}:\n${v.slice(0, 10).join('\n')}`);
  }

  private schedule(bot: SimBot, at: number): void {
    this.heap.push(at, bot.idx);
  }

  private endSession(bot: SimBot): void {
    const jitter = 0.75 + bot.rng.next() * 0.5;
    const next = Math.max(this.now + 5 * MIN, bot.sessionStart + Math.round(bot.cadence.everyMs * jitter));
    this.metrics.onSession(bot, bot.sessionActions);
    bot.sessionStart = next;
    bot.sessionActions = 0;
    bot.sessionTurns = 0;
    this.schedule(bot, next);
  }

  private step(bot: SimBot): void {
    const { s, now, opt } = this;
    const view = viewOf(s, bot, now, this.rng);
    const profile = PROFILES[bot.profile];
    const decision = profile.decide(view, { c: this.content, rng: bot.rng, lang: bot.lang, mem: bot.mem, profile: bot.profile, seed: bot.seed });
    bot.last = null;
    bot.sessionTurns++;
    if ('wait' in decision) {
      this.metrics.onWait(bot, decision.wait);
      if (decision.wait <= opt.maxPauseMs && bot.sessionTurns < bot.cadence.actions * 2) this.schedule(bot, now + decision.wait);
      else this.endSession(bot);
      return;
    }
    const before = this.metrics.beforeAction(bot);
    let r;
    try {
      r = applyAction(s, { agentId: bot.id, action: decision.action, params: decision.params }, { now, rng: this.rng });
    } catch (e) {
      throw new Error(`exception in ${decision.action} ${JSON.stringify(decision.params)} by ${bot.name} (${bot.profile}) at action ${this.actions}: ${(e as Error).message}`, { cause: e });
    }
    this.actions++;
    bot.sessionActions++;
    const res = r.result;
    bot.last = res.ok
      ? { action: res.action, params: decision.params, ok: true, ...(res.data ? { data: res.data } : {}) }
      : { action: decision.action, params: decision.params, ok: false, code: res.error.code, ...(res.error.data ? { data: res.error.data } : {}) };
    this.metrics.afterAction(bot, decision.action, decision.params, res, r.events, before);
    if (bot.sessionActions >= bot.cadence.actions) this.endSession(bot);
    else this.schedule(bot, now + opt.thinkMs[0] + Math.floor(bot.rng.next() * (opt.thinkMs[1] - opt.thinkMs[0])));
  }
}

export function runSimulation(over: Partial<SimOptions> = {}): SimReport {
  return new Simulation(defaultOptions(over)).run();
}
