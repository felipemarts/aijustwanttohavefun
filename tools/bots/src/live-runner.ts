/**
 * Runs scripted bots against a running server over HTTP, through the SDK: for demos and load. Each bot registers
 * itself (flagged as a bot), keeps its key in memory only, then loops: decide, act, pace itself.
 */
import type { Content } from '@ajwf/content';
import { ApiError, createClient, type ActResponse, type Client, type FetchLike, type Room, type You } from '@ajwf/sdk';
import { CLASSES, createRng, LANGUAGES, type LaunchLanguage, type Rng } from '@ajwf/shared';
import { nameGenerator } from './names';
import { RatePacer, Stopper, TokenBucket, percentile } from './pacing';
import { decidePersonality, newMemory, PERSONALITIES, type BotMemory, type Personality } from './personality';
import { inventoryFromMe, viewFromApi, type InventoryView } from './view';

export type LiveOptions = {
  url: string;
  count: number;
  adminToken?: string;
  /** Target total actions per second, across all bots. */
  rate: number;
  seed: number;
  /** Seconds; 0 or undefined runs until stopped. */
  duration?: number;
  /** Longest a bot sits idle when its policy says "wait" (default 15 s), so the world keeps moving. */
  maxWaitMs?: number;
  statusEveryMs?: number;
  log?: (line: string) => void;
  fetch?: FetchLike;
  stopper?: Stopper;
};

/** Per-key budget: the server allows 60 requests per minute; stay safely below it. */
const KEY_BURST = 20;
const KEY_PER_MINUTE = 50;
/** Actions whose effect on the bag only `GET /me` shows. */
const INVENTORY_ACTIONS = new Set(['equip', 'unequip', 'use', 'shop_buy', 'shop_sell', 'gather', 'take', 'drop', 'craft', 'give']);
const ME_EVERY_ACTS = 15;

/** Counters for one status interval and for the whole run. */
export class Stats {
  acts = 0;
  byAction: Record<string, number> = {};
  refusals: Record<string, number> = {};
  transport: Record<string, number> = {};
  http: Record<string, number> = {};
  latencies: number[] = [];
  heard = 0;

  add(other: Stats): void {
    this.acts += other.acts;
    this.heard += other.heard;
    for (const k of ['byAction', 'refusals', 'transport', 'http'] as const) {
      for (const [code, n] of Object.entries(other[k])) this[k][code] = (this[k][code] ?? 0) + n;
    }
    this.latencies.push(...other.latencies);
  }
}

const inc = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);
const fmt = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(' ') || '-';

export function statusLine(label: string, s: Stats, seconds: number, alive: number, total: number): string {
  const p50 = percentile(s.latencies, 50).toFixed(0);
  const p95 = percentile(s.latencies, 95).toFixed(0);
  const http = Object.entries(s.http).filter(([code]) => code !== '200');
  return [
    `[${label}] bots ${alive}/${total}`,
    `${(s.acts / Math.max(seconds, 0.001)).toFixed(1)} act/s (${s.acts})`,
    `latency p50 ${p50}ms p95 ${p95}ms`,
    `actions ${fmt(s.byAction)}`,
    `refused ${fmt(s.refusals)}`,
    `errors ${fmt(s.transport)}`,
    `http ${http.length ? fmt(Object.fromEntries(http)) : 'all 200'}`,
    `heard ${s.heard}`,
  ].join(' | ');
}

type Shared = { content: Content; pacer: RatePacer; stopper: Stopper; maxWaitMs: number; stats: () => Stats };

export class LiveBot {
  alive = true;
  private you: You | null = null;
  private room: Room | null = null;
  private inv: InventoryView | null = null;
  private stale = true;
  private invStale = true;
  private actsSinceMe = 0;
  private lastRefusal = '';
  private refusalStreak = 0;
  private readonly mem: BotMemory = newMemory();
  private readonly bucket: TokenBucket;

  constructor(
    readonly name: string,
    readonly personality: Personality,
    readonly lang: LaunchLanguage,
    private readonly client: Client,
    private readonly rng: Rng,
    private readonly sh: Shared,
  ) {
    this.bucket = new TokenBucket(KEY_BURST, KEY_PER_MINUTE, sh.stopper.sleep, Date.now, () => sh.stopper.isStopped);
  }

  private async refresh(): Promise<boolean> {
    if (this.stale || !this.you || !this.room) {
      await this.bucket.take();
      if (this.sh.stopper.isStopped) return false;
      const look = await this.client.look();
      if (!look.ok) return this.refused(look.error.code);
      if (look.you) this.you = look.you;
      if (look.room) this.room = look.room;
      this.heard(look.messages);
      this.stale = false;
    }
    if (this.invStale || !this.inv || this.actsSinceMe >= ME_EVERY_ACTS) {
      await this.bucket.take();
      if (this.sh.stopper.isStopped) return false;
      const me = await this.client.me();
      if (!me.ok) return this.refused(me.error.code);
      this.inv = inventoryFromMe(me);
      this.you = me.you;
      this.invStale = false;
      this.actsSinceMe = 0;
    }
    return true;
  }

  private heard(messages: ActResponse['messages']): void {
    for (const m of messages ?? []) if ('untrusted_text' in m) this.sh.stats().heard++;
  }

  private refused(code: string): false {
    inc(this.sh.stats().refusals, code);
    this.stale = true;
    this.refusalStreak = code === this.lastRefusal ? this.refusalStreak + 1 : 1;
    this.lastRefusal = code;
    return false;
  }

  /** One decision and its action. */
  async step(): Promise<void> {
    if (!(await this.refresh())) {
      await this.sh.stopper.sleep(this.backoff());
      return;
    }
    const view = viewFromApi(this.sh.content, this.you!, this.room!, this.inv!);
    const step = decidePersonality(this.personality, view, { c: this.sh.content, rng: this.rng, now: Date.now(), lang: this.lang, mem: this.mem });
    if ('wait' in step) {
      await this.sh.stopper.sleep(Math.min(step.wait, this.sh.maxWaitMs) * this.rng.range(0.8, 1.2));
      this.stale = true;
      return;
    }
    await this.sh.pacer.take();
    await this.bucket.take();
    if (this.sh.stopper.isStopped) return;
    const wasFighting = this.you!.in_combat !== undefined;
    const r = await this.client.actRaw(step.action, step.params);
    const stats = this.sh.stats();
    stats.acts++;
    inc(stats.byAction, step.action);
    this.actsSinceMe++;
    if (!r.ok) {
      this.refused(r.error.code);
      await this.sh.stopper.sleep(this.backoff(r.error.code));
      return;
    }
    this.refusalStreak = 0;
    this.lastRefusal = '';
    this.you = r.you;
    if (r.room) this.room = r.room;
    this.heard(r.messages);
    if (INVENTORY_ACTIONS.has(step.action) || (wasFighting && r.you.in_combat === undefined)) this.invStale = true;
  }

  private backoff(code = ''): number {
    if (this.refusalStreak >= 3) return 10_000;
    if (code === 'COOLDOWN') return 3_000;
    if (code === 'NOT_ENOUGH_AP') return 60_000;
    return 500;
  }

  async run(): Promise<void> {
    while (!this.sh.stopper.isStopped && this.alive) {
      try {
        await this.step();
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'EXCEPTION';
        inc(this.sh.stats().transport, code);
        this.stale = true;
        if (code === 'UNAUTHORIZED' || code === 'NO_API_KEY') {
          this.alive = false;
          return;
        }
        const wait = err instanceof ApiError && err.retryAfterSec ? err.retryAfterSec * 1000 : 2_000;
        await this.sh.stopper.sleep(wait);
      }
    }
  }
}

/** Registers one bot, picking a new name when the server refuses one; waits out registration rate limits. */
async function registerBot(
  base: Client,
  nextName: () => string,
  rng: Rng,
  lang: LaunchLanguage,
  bucket: TokenBucket,
  sleep: (ms: number) => Promise<void>,
  stopped: () => boolean,
) {
  for (let attempt = 0; attempt < 12 && !stopped(); attempt++) {
    await bucket.take();
    const name = nextName();
    try {
      const r = await base.register({ name, class: rng.pick(CLASSES), language: lang, appearance: 'surprise_me', bot: true, claimed: true });
      if (r.ok) return { name: r.agent.name, key: r.api_key };
      if (r.error.code === 'NAME_TAKEN' || r.error.code === 'NAME_INVALID') continue;
      throw new Error(`registration refused: ${r.error.code} ${r.error.message}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        await sleep((err.retryAfterSec ?? 5) * 1000);
        continue;
      }
      throw err;
    }
  }
  return null;
}

export type LiveSummary = { registered: number; seconds: number; total: Stats; lines: string[] };

export async function runLiveBots(content: Content, o: LiveOptions): Promise<LiveSummary> {
  const log = o.log ?? console.log;
  const stopper = o.stopper ?? new Stopper();
  const rng = createRng(o.seed);
  let interval = new Stats();
  const total = new Stats();
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };

  const onResponse = (info: { status: number | 'network'; ms: number }) => {
    inc(interval.http, String(info.status));
    if (info.status !== 'network') interval.latencies.push(info.ms);
  };
  const base = createClient({ baseUrl: o.url, adminToken: o.adminToken, fetch: o.fetch, onResponse, sleep: stopper.sleep });
  const shared: Shared = { content, pacer: new RatePacer(o.rate, stopper.sleep), stopper, maxWaitMs: o.maxWaitMs ?? 15_000, stats: () => interval };

  // Registration, ten at a time. The server limits every unauthenticated route, registration included and even with
  // the admin token, to 120 requests per minute per IP: past a first burst, register a little under 2 per second.
  const regBucket = new TokenBucket(100, 110, stopper.sleep, Date.now, () => stopper.isStopped);
  const nextName = nameGenerator(createRng(rng.int(0, 2 ** 31)));
  const bots: LiveBot[] = [];
  const started = Date.now();
  for (let i = 0; i < o.count && !stopper.isStopped; i += 10) {
    const batch = Array.from({ length: Math.min(10, o.count - i) }, (_, j) => {
      const botRng = createRng(rng.int(0, 2 ** 31) ^ (i + j));
      const lang = botRng.pick(LANGUAGES);
      const personality = botRng.pick(PERSONALITIES);
      return registerBot(base, nextName, botRng, lang, regBucket, stopper.sleep, () => stopper.isStopped).then((reg) =>
        reg ? new LiveBot(reg.name, personality, lang, base.withApiKey(reg.key), botRng, shared) : null,
      );
    });
    for (const bot of await Promise.all(batch)) if (bot) bots.push(bot);
  }
  const mix = PERSONALITIES.map((p) => `${p}:${bots.filter((b) => b.personality === p).length}`).join(' ');
  const langs = LANGUAGES.map((l) => `${l}:${bots.filter((b) => b.lang === l).length}`).join(' ');
  say(`registered ${bots.length}/${o.count} bots in ${((Date.now() - started) / 1000).toFixed(1)} s (${mix}; ${langs}; http ${fmt(interval.http)})`);
  interval = new Stats();

  const runStart = Date.now();
  let lastTick = runStart;
  const timer = setInterval(() => {
    const now = Date.now();
    const done = interval;
    interval = new Stats();
    total.add(done);
    say(statusLine(`${Math.round((now - runStart) / 1000)}s`, done, (now - lastTick) / 1000, bots.filter((b) => b.alive).length, bots.length));
    lastTick = now;
  }, o.statusEveryMs ?? 10_000);
  const limit = o.duration ? setTimeout(() => stopper.stop(), o.duration * 1000) : null;

  await Promise.all(bots.map((b) => b.run()));
  clearInterval(timer);
  if (limit) clearTimeout(limit);
  total.add(interval);
  const seconds = (Date.now() - runStart) / 1000;
  say(statusLine(`summary ${seconds.toFixed(0)}s`, total, seconds, bots.filter((b) => b.alive).length, bots.length));
  return { registered: bots.length, seconds, total, lines };
}
