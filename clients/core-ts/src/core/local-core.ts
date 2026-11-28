/**
 * `LocalCore`: the whole `Core` contract, in-process. It owns the characters, talks to the game, runs the engine and
 * schedules play. How a character thinks is the playkit (`Brain`); this file is the session loop around it, the same
 * loop as the desktop core's `internal/core/runner.go` (playkit README section 6).
 *
 * Safety: every object handed out or emitted is scrubbed of secrets; agent keys and claim links stay in the
 * `KeyVault`; nothing the model writes reaches the game unless the playkit validated it against the turn's menu, and
 * with `allowPvp: false` the core checks once more before sending.
 */
import type {
  AppearanceOptions,
  CharacterDetail,
  CharacterId,
  CharacterStatus,
  CharacterSummary,
  ChatMessage,
  Core,
  CoreEvent,
  CoreState,
  Directives,
  EngineChoice,
  EngineState,
  EngineTest,
  ItemStack,
  LogEntry,
  NewCharacter,
  ProviderInfo,
  QuestProgress,
  Settings,
} from '../api.ts';
import type { Brain } from '../brain/types.ts';
import { GameClient, GameError, ordered } from '../game/client.ts';
import { BUILTIN_MODEL, type BuiltinModel } from '../engine/model.ts';
import { EngineError, engineRefused, type Completion, type LlmMessage } from '../engine/types.ts';
import { Playkit } from '../playkit/index.ts';
import { memoryFromText, memoryToText } from '../playkit/codec.ts';
import { arr, at, get, has, isObj, isTrue, members, num, obj, parse, text, write, type JV } from '../playkit/jv.ts';
import type { PaceName } from '../playkit/kit.ts';
import type { SchemaDoc } from '../playkit/schema.ts';
import { clip } from '../playkit/text.ts';
import type { Decision, GameErr, Last, Memory, Message } from '../playkit/types.ts';
import type { Ports, TimerHandle } from '../ports.ts';
import { PriorityLock } from '../util/async.ts';
import { CoreFault, FAULT, isAbort } from '../util/errors.ts';
import { Ids, webRandom } from '../util/ids.ts';
import { Redactor } from '../util/redact.ts';
import { normalizeBaseUrl } from '../util/url.ts';
import { EngineManager } from './engine-manager.ts';
import { pvpViolation } from './pvp.ts';
import { emptyAway, emptyStats, Repo, vaultNames, type CharacterRecord, type PendingAct, type Snapshot, type TurnStats } from './store.ts';
import { Texts, type TextKey, type TextTable } from './text.ts';
import { DEFAULT_TUNING, type Tuning } from './tuning.ts';

export const CORE_VERSION = '0.2.0';

const PRIORITY = { chat: 10, test: 5, turn: 1, memory: 0 } as const;
const NAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const CLASSES = ['warrior', 'mage', 'rogue', 'cleric'] as const;
const PACES = ['relaxed', 'normal', 'active'] as const;
/** Inbox kinds worth a highlight (as the desktop core marks them). */
const BIG_KINDS = new Set(['level_up', 'achievement', 'rare_drop', 'fountain_jackpot', 'title', 'fallen', 'quest_done', 'pvp_kill', 'betrayal']);
const COMPACTION_TOKENS = 400;

export type LocalCoreOptions = {
  ports: Ports;
  /** How characters think: the playkit port (tests may pass another kit). */
  brain?: Brain;
  /** The built-in model pin (tests pass their own). */
  model?: BuiltinModel;
  /** First-run settings. */
  defaults?: Partial<Settings>;
  platform?: 'desktop' | 'mobile';
  version?: string;
  texts?: Record<string, TextTable>;
  tuning?: Partial<Tuning>;
  /** Called with every prompt after scrubbing, before it reaches the engine (tests, debugging). */
  onPrompt?: (messages: LlmMessage[]) => void;
  /** Longest wait for one completion from an external AI server (default 180 s). */
  engineTimeoutMs?: number;
};

type Session = { turns: number; last: Last | null; events: string[] };

type Live = {
  rec: CharacterRecord;
  busy: boolean;
  thinking: boolean;
  ctrl: AbortController | null;
  /** The merged observation (README 6.2), the last /me, the playkit memory. */
  obs: JV;
  me: JV;
  memory: Memory;
  session: Session | null;
  nextPollAt: number;
  /** The events just polled were logged: the next /look does not log its messages again. */
  skipLookLog: boolean;
};

function gauge(v: JV | undefined, fallback: [number, number]): [number, number] {
  const a = arr(v);
  return a.length === 2 && typeof a[0] === 'number' && typeof a[1] === 'number' ? [a[0], a[1]] : fallback;
}

/** README 6.2: parts present in the response replace the stored ones; a /look replaces everything. */
function mergeObs(prev: JV, body: JV, full: boolean): JV {
  const out = !full && isObj(prev) ? new Map(prev) : obj();
  for (const k of ['you', 'room', 'actions', 'time', 'quest', 'pending', 'boss']) if (has(body, k)) out.set(k, get(body, k)!);
  return out;
}

/** XP gained between two `you` objects, across a level-up (as the desktop core counts it). */
function xpGain(prev: JV | undefined, cur: JV | undefined): number {
  const l0 = num(get(prev, 'lvl'));
  const l1 = num(get(cur, 'lvl'));
  const x0 = gauge(get(prev, 'xp'), [0, 0]);
  const x1 = gauge(get(cur, 'xp'), [0, 0]);
  if (l1 === l0) return Math.trunc(x1[0] - x0[0]);
  if (l1 > l0) return Math.trunc(x0[1] - x0[0] + x1[0]);
  return 0;
}

export class LocalCore implements Core {
  private readonly p: Ports;
  private readonly brain: Brain;
  private readonly repo: Repo;
  private readonly redactor = new Redactor();
  private readonly ids: Ids;
  private readonly texts: Texts;
  private readonly tuning: Tuning;
  private readonly lock = new PriorityLock();
  private readonly engines: EngineManager;
  private readonly platform: 'desktop' | 'mobile';
  private readonly version: string;
  private readonly onPrompt?: (messages: LlmMessage[]) => void;
  private readonly defaults: Partial<Settings>;

  private settingsV: Settings = { serverUrl: 'http://localhost:8710', language: 'en', keepAwake: true };
  private chars = new Map<CharacterId, Live>();
  private listeners = new Set<(ev: CoreEvent) => void>();
  private clients = new Map<string, GameClient>();
  private docs = new Map<string, { at: number; doc: SchemaDoc; etag?: string }>();
  private server: CoreState['server'] = { reachable: false };
  private timer: TimerHandle | null = null;
  private timerAt = Infinity;
  private closed = false;
  private optionsCache: { at: number; lang: string; value: AppearanceOptions } | null = null;

  private constructor(o: LocalCoreOptions) {
    this.p = o.ports;
    this.brain = o.brain ?? new Playkit();
    this.repo = new Repo(o.ports.storage);
    this.ids = new Ids(o.ports.random ?? webRandom);
    this.texts = new Texts(o.texts);
    this.tuning = { ...DEFAULT_TUNING, ...o.tuning };
    this.platform = o.platform ?? 'mobile';
    this.version = o.version ?? CORE_VERSION;
    this.onPrompt = o.onPrompt;
    this.defaults = o.defaults ?? {};
    this.engines = new EngineManager({
      repo: this.repo,
      vault: o.ports.vault,
      files: o.ports.files,
      runtime: o.ports.runtime,
      clock: o.ports.clock,
      fetch: o.ports.fetch,
      redactor: this.redactor,
      model: o.model ?? BUILTIN_MODEL,
      emit: (engine) => this.onEngine(engine),
      withLock: (priority, fn) => this.lock.run(priority, fn),
      kit: this.brain.kit,
      ...(o.engineTimeoutMs ? { timeoutMs: o.engineTimeoutMs } : {}),
    });
  }

  /** Loads what is stored and resumes the characters that were playing when the app closed. */
  static async create(o: LocalCoreOptions): Promise<LocalCore> {
    const core = new LocalCore(o);
    await core.init();
    return core;
  }

  private get now(): number {
    return this.p.clock.now();
  }

  private get cfg() {
    return this.brain.kit.config;
  }

  private pace(live: Live) {
    return this.cfg.pace[live.rec.directives.pace as PaceName] ?? this.cfg.pace.normal;
  }

  private async init(): Promise<void> {
    const stored = await this.repo.settings();
    this.settingsV = { serverUrl: 'http://localhost:8710', language: 'en', keepAwake: true, ...this.defaults, ...(stored ?? {}) };
    if (!stored) await this.repo.saveSettings(this.settingsV);
    await this.engines.init().catch(() => undefined);
    for (const rec of await this.repo.characters()) {
      const claim = await this.p.vault.get(vaultNames.claimUrl(rec.id)).catch(() => null);
      this.redactor.add(claim);
      rec.stats ??= emptyStats();
      const live = this.newLive(rec);
      // A session due while the app was closed starts now; a rest that has not ended yet continues.
      if (rec.run) rec.nextActionAt = Math.max(this.now, Math.min(rec.nextActionAt, this.now + this.pace(live).gapSeconds * 1000));
      this.chars.set(rec.id, live);
    }
    void this.pingServer();
    this.schedule();
  }

  private newLive(rec: CharacterRecord): Live {
    const readJson = (s: string | undefined): JV => {
      try {
        return s ? parse(s) : null;
      } catch {
        return null;
      }
    };
    let memory: Memory;
    try {
      memory = memoryFromText(rec.memoryJson);
    } catch {
      memory = memoryFromText(undefined);
    }
    const live: Live = { rec, busy: false, thinking: false, ctrl: null, obs: readJson(rec.obsJson), me: readJson(rec.meJson), memory, session: null, nextPollAt: 0, skipLookLog: false };
    live.nextPollAt = this.now + this.pace(live).pollSeconds * 1000;
    return live;
  }

  /** Stops every timer and in-flight model call, and unloads the built-in model. The core cannot be used after. */
  async close(): Promise<void> {
    this.closed = true;
    this.timer?.cancel();
    this.timer = null;
    for (const live of this.chars.values()) live.ctrl?.abort();
    await this.engines.pauseDownload().catch(() => undefined);
    await this.p.runtime.unload().catch(() => undefined);
    this.listeners.clear();
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────────────────────────

  subscribe(listener: (ev: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: CoreEvent): void {
    if (this.closed) return;
    const safe = this.redactor.scrubDeep(ev);
    for (const l of [...this.listeners]) {
      try {
        l(safe);
      } catch {
        // A listener's failure is the interface's problem, not the scheduler's.
      }
    }
  }

  private emitCharacter(live: Live): void {
    this.emit({ type: 'character', character: this.summary(live) });
  }

  private onEngine(engine: EngineState): void {
    this.emit({ type: 'engine', engine });
    if (engine.status === 'ready') {
      for (const live of this.chars.values()) {
        if (live.rec.run && live.rec.waitReason === 'engine') {
          live.rec.nextActionAt = this.now;
          live.rec.waitReason = undefined;
          live.rec.problem = undefined;
        }
      }
      this.schedule();
    }
  }

  private setReachable(reachable: boolean, skillVersion?: string): void {
    const next = { reachable, ...(skillVersion ? { skillVersion } : this.server.skillVersion ? { skillVersion: this.server.skillVersion } : {}) };
    if (next.reachable !== this.server.reachable || next.skillVersion !== this.server.skillVersion) {
      this.server = next;
      this.emit({ type: 'server', server: { ...next } });
    }
  }

  private async pingServer(): Promise<void> {
    const r = await this.client(this.settingsV.serverUrl).ping();
    this.setReachable(r.reachable, r.skillVersion);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

  private client(server: string): GameClient {
    let c = this.clients.get(server);
    if (!c) {
      c = new GameClient(server, {
        fetch: this.p.fetch,
        clock: this.p.clock,
        vault: this.p.vault,
        redactor: this.redactor,
        perMinute: this.cfg.requests.perMinute,
        maxRetryWaitMs: this.cfg.requests.maxRetryAfterSeconds * 1000,
        onReachable: (r) => {
          if (server === this.settingsV.serverUrl) this.setReachable(r);
        },
      });
      this.clients.set(server, c);
    }
    return c;
  }

  /** The action schema of a server, revalidated with its ETag at most every `schemaTtl` (README 3.1). */
  private async schemaDoc(server: string): Promise<SchemaDoc> {
    const cached = this.docs.get(server);
    if (cached && this.now - cached.at < this.tuning.schemaTtl) return cached.doc;
    try {
      const r = await this.client(server).schemaDoc(cached?.etag);
      if (r === null && cached) {
        cached.at = this.now;
        return cached.doc;
      }
      if (r === null) throw new GameError('BAD_RESPONSE', 'The game server sent no action schema.');
      this.docs.set(server, { at: this.now, doc: r.doc, ...(r.etag ? { etag: r.etag } : {}) });
      if (server === this.settingsV.serverUrl && r.doc.skillVersion) this.setReachable(true, r.doc.skillVersion);
      return r.doc;
    } catch (e) {
      if (cached) return cached.doc;
      throw e;
    }
  }

  private live(id: CharacterId): Live {
    const live = typeof id === 'string' ? this.chars.get(id) : undefined;
    if (!live) throw new CoreFault(FAULT.notFound, 'No such character on this device.');
    return live;
  }

  private t(key: TextKey, p?: Record<string, string | number>): string {
    return this.texts.t(this.settingsV.language, key, p);
  }

  private async save(live: Live): Promise<void> {
    const r = live.rec;
    if (live.obs !== null) r.obsJson = write(live.obs);
    if (live.me !== null) r.meJson = write(live.me);
    r.memoryJson = memoryToText(live.memory);
    await this.repo.saveCharacter(r);
  }

  private addHighlight(live: Live, s: string): void {
    live.rec.away.highlights = [clip(s, 160), ...live.rec.away.highlights].slice(0, 5);
  }

  private async writeLog(live: Live, e: Omit<LogEntry, 'id' | 'ts'>): Promise<LogEntry> {
    const ts = this.now;
    const entry = this.redactor.scrubDeep({ id: this.ids.sortable(ts), ts, ...e }) as LogEntry;
    await this.repo.appendLog(live.rec.id, entry);
    this.emit({ type: 'log', id: live.rec.id, entry });
    return entry;
  }

  /** One game message as a log entry: agent-written text becomes a quote, never plain text. */
  private async logMessage(live: Live, m: JV): Promise<void> {
    const kind = text(get(m, 'kind'));
    const big = BIG_KINDS.has(kind);
    if (has(m, 'untrusted_text')) {
      const from = text(get(m, 'from'));
      await this.writeLog(live, { kind: 'event', text: `${from} (${kind.replace(/_/g, ' ')})`, quote: { from, text: text(get(m, 'untrusted_text')).slice(0, 2000) }, ...(big ? { big: true } : {}) });
      return;
    }
    const t = text(get(m, 'text'));
    if (t === '') return;
    if (big) this.addHighlight(live, t);
    await this.writeLog(live, { kind: 'event', text: t, ...(big ? { big: true } : {}) });
  }

  // ── Summaries ───────────────────────────────────────────────────────────────────────────────────────────────

  /** The summary values, from the merged observation. */
  private updateSnapshot(live: Live): void {
    const you = get(live.obs, 'you');
    const room = get(live.obs, 'room');
    if (!isObj(you) && !isObj(room)) return;
    const prev = live.rec.snapshot;
    const s: Snapshot = prev ? { ...prev } : { level: 1, xp: [0, 100], hp: [0, 0], mp: [0, 0], ap: [0, 0], gold: 0, roomId: '', roomName: '', title: null };
    if (isObj(you)) {
      s.level = num(get(you, 'lvl')) || s.level;
      s.xp = gauge(get(you, 'xp'), s.xp);
      s.hp = gauge(get(you, 'hp'), s.hp);
      s.mp = gauge(get(you, 'mp'), s.mp);
      s.ap = gauge(get(you, 'ap'), s.ap);
      s.gold = num(get(you, 'gold'));
      s.title = has(you, 'title') ? text(get(you, 'title')) || null : s.title;
      const ic = text(get(you, 'in_combat'));
      if (ic) s.inCombat = ic;
      else delete s.inCombat;
      const fallen = num(get(you, 'fallen'));
      if (has(you, 'fallen') && fallen > 0) s.fallenUntil = this.now + fallen * 1000;
      else delete s.fallenUntil;
      const party = get(you, 'party');
      if (isObj(party)) s.partyMembers = arr(get(party, 'members')).map((m) => text(m));
      else delete s.partyMembers;
      const guild = text(get(you, 'guild'));
      if (guild) s.guild = guild;
      else delete s.guild;
    }
    if (isObj(room)) {
      s.roomId = text(get(room, 'id'));
      s.roomName = text(get(room, 'name')) || s.roomId;
    }
    live.rec.snapshot = s;
  }

  private status(live: Live): CharacterStatus {
    const r = live.rec;
    if (!r.run) return 'paused';
    if (live.thinking) return 'thinking';
    if (r.waitReason === 'engine' || r.waitReason === 'server' || r.waitReason === 'key') return 'blocked';
    if (r.snapshot?.fallenUntil && r.snapshot.fallenUntil > this.now) return 'fallen';
    if (!live.session && r.nextActionAt > this.now + 1_000) return 'resting';
    return 'playing';
  }

  private activity(live: Live, status: CharacterStatus): string {
    const r = live.rec;
    switch (status) {
      case 'paused':
        return this.t('paused');
      case 'thinking':
        return this.t('thinking');
      case 'fallen':
        return this.t('fallen');
      case 'blocked':
        return r.problem ?? this.t('blocked_server');
      case 'resting':
        return this.t(r.waitReason === 'ap' ? 'resting_ap' : 'resting_until', { time: this.texts.time(this.settingsV.language, r.nextActionAt) });
      default:
        if (r.snapshot?.inCombat) return this.t('fighting', { target: r.snapshot.inCombat });
        return r.snapshot ? this.t('exploring', { room: r.snapshot.roomName }) : this.t('idle');
    }
  }

  private summary(live: Live): CharacterSummary {
    const r = live.rec;
    const s = r.snapshot;
    const status = this.status(live);
    const out: CharacterSummary = {
      id: r.id,
      name: r.name,
      class: r.class,
      level: s?.level ?? 1,
      xp: s?.xp ?? [0, 100],
      hp: s?.hp ?? [0, 0],
      mp: s?.mp ?? [0, 0],
      ap: s?.ap ?? [0, 0],
      gold: s?.gold ?? 0,
      room: { id: s?.roomId ?? '', name: s?.roomName ?? '' },
      sprite: r.sprite,
      title: s?.title ?? null,
      status,
      activity: this.activity(live, status),
      claimed: r.claimed,
      claimPending: !r.claimed && r.hasClaimUrl,
      watchUrl: `${r.server}/a/${encodeURIComponent(r.name)}`,
    };
    if ((status === 'resting' || status === 'fallen' || status === 'blocked') && r.nextActionAt > this.now) out.nextActionAt = r.nextActionAt;
    if (status === 'blocked' && r.problem) out.problem = r.problem;
    const away = r.away;
    if (away.actions > 0 || away.highlights.length > 0 || away.deaths > 0) out.away = { ...away, highlights: [...away.highlights] };
    return out;
  }

  // ── State and settings ──────────────────────────────────────────────────────────────────────────────────────

  async state(): Promise<CoreState> {
    return {
      version: this.version,
      playkit: this.brain.version,
      platform: this.platform,
      settings: { ...this.settingsV },
      engine: this.engines.state(),
      characters: [...this.chars.values()].sort((a, b) => a.rec.createdAt - b.rec.createdAt).map((l) => this.summary(l)),
      server: { ...this.server },
    };
  }

  async settings(): Promise<Settings> {
    return { ...this.settingsV };
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    if (!patch || typeof patch !== 'object') throw new CoreFault(FAULT.invalid, 'Settings must be an object.');
    const next: Settings = { ...this.settingsV };
    if (patch.serverUrl !== undefined) next.serverUrl = normalizeBaseUrl(patch.serverUrl, 'game server address');
    if (patch.language !== undefined) {
      if (typeof patch.language !== 'string' || !LANG_RE.test(patch.language)) throw new CoreFault(FAULT.invalid, 'The language must be a BCP-47 tag such as en or pt-BR.');
      next.language = patch.language;
    }
    if (patch.keepAwake !== undefined) next.keepAwake = !!patch.keepAwake;
    const serverChanged = next.serverUrl !== this.settingsV.serverUrl;
    this.settingsV = next;
    await this.repo.saveSettings(next);
    if (serverChanged) {
      this.optionsCache = null;
      this.server = { reachable: false };
      void this.pingServer();
    }
    for (const live of this.chars.values()) this.emitCharacter(live);
    return { ...next };
  }

  // ── Characters ──────────────────────────────────────────────────────────────────────────────────────────────

  async appearanceOptions(): Promise<AppearanceOptions> {
    const lang = this.settingsV.language;
    const c = this.optionsCache;
    // A token is valid 30 minutes; reuse it for 20.
    if (c && c.lang === lang && this.now - c.at < Math.min(20 * 60_000, c.value.expiresIn * 1000 - 60_000)) return c.value;
    const r = await this.game(() => this.client(this.settingsV.serverUrl).appearanceOptions(lang));
    const value: AppearanceOptions = { optionsToken: r.options_token, expiresIn: r.expires_in, options: r.options };
    this.optionsCache = { at: this.now, lang, value };
    return value;
  }

  private async game<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.fault(e);
    }
  }

  private fault(e: unknown): CoreFault {
    if (e instanceof CoreFault) return e;
    if (e instanceof GameError) {
      const code =
        e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'REDIRECT' || e.code === 'SERVER_ERROR'
          ? FAULT.network
          : e.code === 'RATE_LIMITED'
            ? FAULT.rateLimited
            : e.code === 'UNAUTHORIZED' || e.code === 'NO_KEY'
              ? FAULT.unauthorized
              : e.code === 'BAD_RESPONSE'
                ? FAULT.badResponse
                : gameCode(e.code);
      return new CoreFault(code, this.redactor.scrub(e.message));
    }
    if (e instanceof EngineError) return new CoreFault(e.code === 'not_installed' ? FAULT.notAvailable : FAULT.engine, this.redactor.scrub(e.message));
    return new CoreFault(FAULT.badResponse, 'Something went wrong.');
  }

  private validDirectives(d: unknown, fallback?: Directives): Directives {
    if (!d || typeof d !== 'object') throw new CoreFault(FAULT.invalid, 'Directives must be an object.');
    const x = d as Partial<Directives>;
    const persona = typeof x.persona === 'string' ? clip(x.persona.trim(), 2000) : (fallback?.persona ?? '');
    const wish = typeof x.wish === 'string' ? clip(x.wish.trim(), 1000) : (fallback?.wish ?? '');
    const pace = x.pace ?? fallback?.pace ?? 'normal';
    if (!PACES.includes(pace)) throw new CoreFault(FAULT.invalid, 'Pace must be relaxed, normal or active.');
    const allowPvp = typeof x.allowPvp === 'boolean' ? x.allowPvp : (fallback?.allowPvp ?? false);
    return { persona, wish, pace, allowPvp };
  }

  async createCharacter(input: NewCharacter): Promise<CharacterSummary> {
    if (!input || typeof input !== 'object') throw new CoreFault(FAULT.invalid, 'A new character needs a name, class, language and persona.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(name)) throw new CoreFault(FAULT.invalidName, 'The name must be 3 to 20 letters, digits, _ or -.');
    if (!CLASSES.includes(input.class)) throw new CoreFault(FAULT.invalid, 'The class must be warrior, mage, rogue or cleric.');
    if (typeof input.language !== 'string' || !LANG_RE.test(input.language)) throw new CoreFault(FAULT.invalid, 'The language must be a BCP-47 tag such as en or pt-BR.');
    if (input.bio !== undefined && typeof input.bio !== 'string') throw new CoreFault(FAULT.invalid, 'The bio must be text.');
    const bio = typeof input.bio === 'string' ? input.bio.trim() : '';
    if ([...bio].length > 300) throw new CoreFault(FAULT.invalid, 'The bio may have at most 300 characters.');
    const directives = this.validDirectives({ persona: input.persona, wish: input.wish ?? '', pace: input.pace ?? 'normal', allowPvp: input.allowPvp ?? false });
    let appearance: 'surprise_me' | Record<string, string>;
    let optionsToken: string | undefined;
    if (input.appearance === 'surprise_me') appearance = 'surprise_me';
    else if (input.appearance && typeof input.appearance === 'object' && typeof input.appearance.optionsToken === 'string' && input.appearance.choice && typeof input.appearance.choice === 'object') {
      appearance = Object.fromEntries(Object.entries(input.appearance.choice).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'));
      optionsToken = input.appearance.optionsToken;
    } else throw new CoreFault(FAULT.invalid, 'Appearance must be surprise_me or a choice with its options token.');

    const server = this.settingsV.serverUrl;
    const client = this.client(server);
    // The persona stays on the device; only the optional public bio goes to the game.
    const r = await this.game(() => client.register({ name, class: input.class, language: input.language, ...(bio ? { bio } : {}), appearance, ...(optionsToken ? { options_token: optionsToken } : {}) }));
    if (!r.ok) throw new CoreFault(gameCode(r.error.code), this.redactor.scrub([r.error.message, r.error.hint].filter(Boolean).join(' ')));
    const id = this.ids.opaque('c_', 12);
    this.redactor.add(r.api_key);
    this.redactor.add(r.claim_url);
    await this.p.vault.set(vaultNames.agentKey(id), r.api_key);
    await this.p.vault.set(vaultNames.claimUrl(id), r.claim_url);
    const now = this.now;
    const rec: CharacterRecord = {
      id,
      server,
      name: r.agent.name,
      class: input.class,
      language: input.language,
      bio,
      createdAt: now,
      directives,
      run: true,
      nextActionAt: now,
      snapshot: null,
      sprite: null,
      claimed: false,
      hasClaimUrl: true,
      away: emptyAway(now),
      failures: 0,
      stats: emptyStats(),
    };
    const live = this.newLive(rec);
    this.chars.set(id, live);
    // The first look and the sprite, best effort: the character exists whatever happens next.
    try {
      live.obs = mergeObs(null, this.fromGame(await client.look(vaultNames.agentKey(id))), true);
      this.updateSnapshot(live);
    } catch {
      // the first session will look again
    }
    try {
      const p = await client.profile(rec.name);
      if (p.agent.sprite) rec.sprite = new URL(p.agent.sprite, `${server}/`).toString();
    } catch {
      // no sprite yet
    }
    await this.save(live);
    await this.writeLog(live, { kind: 'system', text: this.t('created', { name: rec.name }) });
    this.emitCharacter(live);
    this.schedule();
    return this.summary(live);
  }

  async character(id: CharacterId): Promise<CharacterDetail> {
    const live = this.live(id);
    const r = live.rec;
    if (!isObj(live.me) || !r.meAt || this.now - r.meAt > this.tuning.detailTtl) await this.refreshMe(live).catch(() => undefined);
    const me = live.me;
    const lang = this.settingsV.language;
    const slotOf = (slot: string) => ({ id: slot, name: this.texts.slot(lang, slot) });
    const equipped = new Map(members(get(me, 'equipment')).map(([slot, item]) => [text(item), slot]));
    const inventory: ItemStack[] = [];
    // Names are the game's ids (the compact API gives no item names).
    for (const [item, qty] of members(get(me, 'inventory'))) {
      const slot = equipped.get(item);
      inventory.push({ id: item, name: item, qty: num(qty), ...(slot ? { slot: slotOf(slot) } : {}) });
      equipped.delete(item);
    }
    for (const [item, slot] of equipped) if (item) inventory.push({ id: item, name: item, qty: 1, slot: slotOf(slot) });
    const quests: QuestProgress[] = arr(get(me, 'quests')).map((q) => ({
      id: text(get(q, 'id')),
      name: text(get(q, 'id')),
      steps: arr(get(q, 'steps')).map((s) => ({ text: [text(get(s, 'do')), text(get(s, 'target'))].filter(Boolean).join(' '), have: num(get(s, 'have')), need: num(get(s, 'need')) })),
      ready: isTrue(get(q, 'ready')),
    }));
    const ach = get(me, 'achievements');
    const achievements = Array.isArray(ach)
      ? ach.map((a) => text(a))
      : members(ach)
          .sort((a, b) => num(b[1]) - num(a[1]))
          .map(([k]) => k);
    return {
      ...this.summary(live),
      bio: text(at(me, 'agent', 'bio', 'untrusted_text')) || r.bio,
      stats: members(get(me, 'stats')).map(([sid, v]) => ({ id: sid, name: this.texts.stat(lang, sid), value: num(v) })),
      inventory,
      quests,
      achievements,
      party: r.snapshot?.partyMembers ? { members: [...r.snapshot.partyMembers] } : null,
      guild: r.snapshot?.guild ?? null,
      directives: { ...r.directives },
      memory: [...live.memory.notes],
    };
  }

  async seen(id: CharacterId): Promise<CharacterSummary> {
    const live = this.live(id);
    live.rec.away = emptyAway(this.now);
    await this.save(live);
    this.emitCharacter(live);
    return this.summary(live);
  }

  /** The claim link while unclaimed, else null. Only here: never in summaries, events, logs or prompts. */
  async claimLink(id: CharacterId): Promise<string | null> {
    const live = this.live(id);
    if (live.rec.claimed || !live.rec.hasClaimUrl) return null;
    return this.p.vault.get(vaultNames.claimUrl(live.rec.id));
  }

  async log(id: CharacterId, opts: { before?: string; limit?: number } = {}): Promise<LogEntry[]> {
    const live = this.live(id);
    const limit = Math.max(1, Math.min(200, Math.floor(Number(opts?.limit ?? 50)) || 50));
    const before = typeof opts?.before === 'string' && /^[0-9a-z]{1,40}$/.test(opts.before) ? opts.before : undefined;
    return this.repo.log(live.rec.id, before, limit);
  }

  async control(id: CharacterId, run: boolean): Promise<CharacterSummary> {
    const live = this.live(id);
    const r = live.rec;
    if (typeof run !== 'boolean') throw new CoreFault(FAULT.invalid, 'run must be true or false.');
    if (r.run !== run) {
      r.run = run;
      if (run) {
        r.nextActionAt = this.now;
        r.waitReason = undefined;
        r.problem = undefined;
        r.failures = 0;
        await this.writeLog(live, { kind: 'system', text: this.t('started') });
      } else {
        // Pausing cancels the thinking in progress and ends the session; an action already sent finishes and is logged.
        live.ctrl?.abort();
        live.thinking = false;
        live.session = null;
        await this.writeLog(live, { kind: 'system', text: this.t('stopped') });
      }
      await this.save(live);
      this.emitCharacter(live);
      this.schedule();
    }
    return this.summary(live);
  }

  async setDirectives(id: CharacterId, d: Directives): Promise<Directives> {
    const live = this.live(id);
    const next = this.validDirectives(d, live.rec.directives);
    live.rec.directives = next;
    await this.save(live);
    this.emitCharacter(live);
    this.schedule();
    return { ...next };
  }

  /** A wish from the owner for the next `commandTurns` turns; wakes the character (as the desktop core does). */
  async command(id: CharacterId, text: string): Promise<void> {
    const live = this.live(id);
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) throw new CoreFault(FAULT.invalid, 'The command is empty.');
    live.rec.command = { text: clip(t, 2000), turnsLeft: this.brain.kit.lim('commandTurns') };
    await this.writeLog(live, { kind: 'system', text: this.t('owner_command', { text: clip(t, 200) }) });
    if (live.rec.run && !live.session && (live.rec.waitReason === 'session' || live.rec.waitReason === 'ap' || live.rec.waitReason === undefined)) live.rec.nextActionAt = this.now;
    await this.save(live);
    this.emitCharacter(live);
    this.schedule();
  }

  async chat(id: CharacterId, text: string): Promise<ChatMessage> {
    const live = this.live(id);
    const t = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!t) throw new CoreFault(FAULT.invalid, 'The message is empty.');
    const history = (await this.repo.chats(live.rec.id, this.brain.kit.lim('chatHistory'))).map((m) => ({ from: m.from, text: m.text }));
    // Even the owner's own words are scrubbed: a key pasted into the chat is not kept, nor shown to the model.
    const ownerText = this.redactor.scrub(t);
    await this.repo.appendChat(live.rec.id, { id: this.ids.sortable(this.now), ts: this.now, from: 'owner', text: ownerText });
    await this.engines.refresh();
    if (!this.engines.ready) throw new CoreFault(FAULT.notAvailable, 'The AI engine is not ready.');
    const r = live.rec;
    const messages = this.brain.chatTurn({ character: this.character_(live), observation: live.obs, me: live.me, memory: live.memory, history, text: ownerText });
    const messageId = this.ids.sortable(this.now);
    let reply: string;
    try {
      const c = await this.infer(messages, undefined, this.cfg.sampling.chatMaxTokens, PRIORITY.chat, undefined, (token) => this.emit({ type: 'chat', id: r.id, messageId, token }));
      reply = c.text.trim();
    } catch (e) {
      if (e instanceof EngineError) this.engines.noteFailure(e);
      this.emit({ type: 'chat', id: r.id, messageId, token: '', done: true });
      throw this.fault(e);
    }
    this.emit({ type: 'chat', id: r.id, messageId, token: '', done: true });
    if (!reply) throw new CoreFault(FAULT.engine, 'The AI gave no answer.');
    const msg: ChatMessage = this.redactor.scrubDeep({ id: messageId, ts: this.now, from: 'character', text: reply.slice(0, 4000) });
    await this.repo.appendChat(r.id, msg);
    return msg;
  }

  async chatHistory(id: CharacterId, limit = 50): Promise<ChatMessage[]> {
    const live = this.live(id);
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 50));
    return this.repo.chats(live.rec.id, n);
  }

  async forget(id: CharacterId): Promise<void> {
    const live = this.live(id);
    live.rec.run = false;
    live.ctrl?.abort();
    this.chars.delete(id);
    await this.p.vault.delete(vaultNames.agentKey(id));
    await this.p.vault.delete(vaultNames.claimUrl(id));
    await this.repo.forget(id);
    this.emit({ type: 'removed', id });
    this.schedule();
  }

  /** Not in the contract: per-character turn counters (accepted rate, inference time), as the desktop core keeps. */
  async stats(id: CharacterId): Promise<TurnStats> {
    return { ...this.live(id).rec.stats };
  }

  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────────────────

  async engine(): Promise<EngineState> {
    return this.engines.refresh();
  }

  providers(): Promise<ProviderInfo[]> {
    return this.engines.providers();
  }

  probeProvider(url: string): Promise<ProviderInfo> {
    return this.engines.probeProvider(url);
  }

  setEngine(choice: EngineChoice): Promise<EngineState> {
    return this.engines.setChoice(choice);
  }

  startDownload(): Promise<EngineState> {
    return this.engines.startDownload();
  }

  pauseDownload(): Promise<EngineState> {
    return this.engines.pauseDownload();
  }

  cancelDownload(): Promise<EngineState> {
    return this.engines.cancelDownload();
  }

  testEngine(): Promise<EngineTest> {
    return this.engines.test();
  }

  /** For tests and the harness: resolves when a running download ends. */
  downloadSettled(): Promise<void> {
    return this.engines.downloadSettled();
  }

  // ── The model ───────────────────────────────────────────────────────────────────────────────────────────────

  /** One inference under the device-wide lock, with the playkit's sampling. */
  private async infer(messages: Message[], schema: JV | undefined, maxTokens: number, priority: number, signal?: AbortSignal, onToken?: (t: string) => void): Promise<Completion> {
    const engine = this.engines.engine;
    if (!engine) throw new EngineError('not_installed', 'The AI engine is not ready.');
    // Defence in depth: the playkit's inputs carry no secret, and whatever slipped is scrubbed before the model.
    const safe = messages.map((m) => ({ role: m.role, content: this.redactor.scrub(m.content) }));
    this.onPrompt?.(safe);
    const s = this.cfg.sampling;
    const r = await this.lock.run(
      priority,
      () => engine.complete(safe, { ...(schema !== undefined ? { schema } : {}), maxTokens, temperature: s.temperature, topK: s.topK, repeatPenalty: s.repeatPenalty, ...(signal ? { signal } : {}), ...(onToken ? { onToken } : {}) }),
      signal,
    );
    this.engines.noteSpeed(r.tokens, r.ms);
    return r;
  }

  /**
   * A game answer as the playkit reads it: member order kept, and any known secret scrubbed once, here, before the
   * observation, /me, memory or `last` hold it (a careless server echoing a key never reaches storage or a prompt).
   */
  private fromGame(x: unknown): JV {
    return this.redactor.scrubOrdered(ordered(x));
  }

  private character_(live: Live) {
    const r = live.rec;
    return { name: r.name, class: r.class, language: r.language, persona: r.directives.persona, wish: r.directives.wish, allowPvp: r.directives.allowPvp };
  }

  // ── Scheduler ───────────────────────────────────────────────────────────────────────────────────────────────

  private dueAt(live: Live): number {
    const r = live.rec;
    if (!r.run || live.busy) return Infinity;
    // Between sessions it also wakes to poll its events.
    const resting = !live.session && r.nextActionAt > this.now && (r.waitReason === 'session' || r.waitReason === 'ap');
    return resting ? Math.min(r.nextActionAt, live.nextPollAt) : r.nextActionAt;
  }

  private schedule(): void {
    if (this.closed) return;
    let at = Infinity;
    for (const live of this.chars.values()) at = Math.min(at, this.dueAt(live));
    if (at === this.timerAt && this.timer) return;
    this.timer?.cancel();
    this.timer = null;
    this.timerAt = at;
    if (!Number.isFinite(at)) return;
    this.timer = this.p.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.tick();
    }, Math.max(0, at - this.now));
  }

  private tick(): void {
    if (this.closed) return;
    const now = this.now;
    for (const live of this.chars.values()) if (this.dueAt(live) <= now) void this.step(live);
    this.schedule();
  }

  /** Whether no character is in the middle of a step (tests and the harness). */
  get idle(): boolean {
    return [...this.chars.values()].every((l) => !l.busy);
  }

  private async step(live: Live): Promise<void> {
    live.busy = true;
    const ctrl = new AbortController();
    live.ctrl = ctrl;
    try {
      if (!live.session && this.now < live.rec.nextActionAt) await this.poll(live);
      else await this.turn(live, ctrl.signal);
      live.rec.failures = 0;
    } catch (e) {
      await this.failed(live, e);
    } finally {
      live.thinking = false;
      live.busy = false;
      live.ctrl = null;
      if (this.chars.has(live.rec.id)) {
        await this.save(live).catch(() => undefined);
        this.emitCharacter(live);
      }
      this.schedule();
    }
  }

  private wait(live: Live, ms: number, reason: CharacterRecord['waitReason'], problem?: string): void {
    live.rec.nextActionAt = this.now + Math.max(0, ms);
    live.rec.waitReason = reason;
    live.rec.problem = problem;
    live.nextPollAt = this.now + this.pace(live).pollSeconds * 1000;
  }

  private backoff(live: Live): number {
    live.rec.failures++;
    return Math.min(this.tuning.maxBackoff, 30_000 * 2 ** Math.min(10, live.rec.failures - 1));
  }

  private async failed(live: Live, e: unknown): Promise<void> {
    if (isAbort(e) || (e instanceof GameError && e.code === 'ABORTED') || (e instanceof EngineError && e.code === 'aborted')) return;
    live.session = null;
    live.thinking = false;
    if (e instanceof GameError) {
      if (e.code === 'RATE_LIMITED') return this.wait(live, e.retryAfterMs ?? 60_000, 'rate');
      if (e.code === 'UNAUTHORIZED' || e.code === 'NO_KEY') return this.wait(live, this.tuning.keyRetry, 'key', this.t('blocked_key'));
      return this.wait(live, this.backoff(live), 'server', this.t('blocked_server'));
    }
    if (e instanceof EngineError) {
      this.engines.noteFailure(e);
      const first = live.rec.waitReason !== 'engine';
      this.wait(live, this.tuning.engineRetry, 'engine', this.t('blocked_engine'));
      if (first) await this.writeLog(live, { kind: 'system', text: this.t('engine_problem', { reason: e.message }) }).catch(() => undefined);
      return;
    }
    this.wait(live, this.backoff(live), 'server', this.t('blocked_server'));
  }

  /** While resting: read the events (README 6.3), log them, and start the session at once when one wakes it. */
  private async poll(live: Live): Promise<void> {
    const r = live.rec;
    live.nextPollAt = this.now + this.pace(live).pollSeconds * 1000;
    if (!r.cursor) return;
    const client = this.client(r.server);
    let woke = '';
    let cursor = r.cursor;
    for (let page = 0; page < 5; page++) {
      const ev = this.fromGame(await client.events(vaultNames.agentKey(r.id), cursor));
      for (const e of arr(get(ev, 'events'))) {
        await this.logMessage(live, e);
        if (woke === '' && this.brain.wakes(e, r.name)) woke = text(get(e, 'kind'));
      }
      const cur = text(get(ev, 'cursor'));
      if (cur) cursor = cur;
      if (get(ev, 'more') !== true) break;
    }
    r.cursor = cursor;
    live.skipLookLog = true;
    if (woke) {
      r.nextActionAt = this.now;
      await this.writeLog(live, { kind: 'system', text: this.t('woke', { kind: woke.replace(/_/g, ' ') }) });
    }
  }

  /** README 6.1 step 1: schema, /look, /me, the world map, the look's chat lines. */
  private async startSession(live: Live): Promise<void> {
    const r = live.rec;
    const client = this.client(r.server);
    const key = vaultNames.agentKey(r.id);
    await this.schemaDoc(r.server);
    const look = this.fromGame(await client.look(key));
    const me = await client.me(key).then((x) => this.fromGame(x), () => null);
    live.obs = mergeObs(live.obs, look, true);
    this.brain.observe(live.memory.world, live.obs);
    const cur = text(get(look, 'cursor'));
    if (cur) r.cursor = cur;
    if (me !== null) this.takeMe(live, me);
    r.stats.sessions++;
    this.updateSnapshot(live);
    await this.writeLog(live, { kind: 'system', text: this.t('session_start', { ap: r.snapshot?.ap[0] ?? 0 }) });
    const heard = this.brain.heard(get(look, 'messages'));
    if (!live.skipLookLog) for (const m of arr(get(look, 'messages'))) await this.logMessage(live, m);
    live.skipLookLog = false;
    this.brain.remember(live.memory, null, '', heard.chat);
    live.session = { turns: 0, last: { action: 'look', params: obj(), ok: true, narration: text(get(look, 'narration')) }, events: heard.events };
    r.waitReason = undefined;
    r.problem = undefined;
  }

  private takeMe(live: Live, me: JV): void {
    const r = live.rec;
    live.me = me;
    r.meAt = this.now;
    const claimed = at(me, 'agent', 'claimed') === true;
    if (claimed && !r.claimed) void this.writeLog(live, { kind: 'system', text: this.t('claimed') });
    r.claimed = claimed;
    if (claimed && r.hasClaimUrl) {
      // A used claim link is worth nothing; it is not kept.
      r.hasClaimUrl = false;
      void this.p.vault.delete(vaultNames.claimUrl(r.id));
    }
  }

  private async refreshMe(live: Live): Promise<void> {
    const r = live.rec;
    this.takeMe(live, this.fromGame(await this.client(r.server).me(vaultNames.agentKey(r.id))));
    if (!r.sprite) {
      const p = await this.client(r.server).profile(r.name).catch(() => null);
      if (p?.agent.sprite) r.sprite = new URL(p.agent.sprite, `${r.server}/`).toString();
    }
  }

  /** README 6.3: rest the pace's gap, and long enough for AP to come back to `resumeAt`. */
  private async endSession(live: Live, why: 'why_turns' | 'why_ap' | 'why_none'): Promise<void> {
    const ap = num(arr(at(live.obs, 'you', 'ap'))[0]);
    const gap = this.pace(live).gapSeconds * 1000;
    const need = this.cfg.ap.resumeAt - ap;
    const apWait = need > 0 ? need * this.cfg.ap.regenSeconds * 1000 : 0;
    live.session = null;
    this.wait(live, Math.max(gap, apWait), apWait > gap ? 'ap' : 'session');
    await this.writeLog(live, { kind: 'system', text: this.t('session_end', { why: this.t(why) }) });
  }

  /** One turn of a session (README 6.1 step 2), starting the session first when there is none. */
  private async turn(live: Live, signal: AbortSignal): Promise<void> {
    const r = live.rec;
    if (!this.engines.ready) {
      await this.engines.refresh();
      if (!this.engines.ready) {
        const first = r.waitReason !== 'engine';
        this.wait(live, this.tuning.engineRetry, 'engine', this.t('blocked_engine'));
        if (first) await this.writeLog(live, { kind: 'system', text: this.t('blocked_engine') });
        return;
      }
    }
    if (!live.session) await this.startSession(live);
    const session = live.session!;
    // An action sent before the app closed and never answered: repeat it with the same key; the server returns the
    // stored answer if it was applied.
    if (r.pendingAct) {
      const p = r.pendingAct;
      if (this.now - p.at < this.tuning.pendingActTtl) {
        await this.sendAct(live, p, null, 0, this.now);
        await this.writeLog(live, { kind: 'system', text: this.t('resumed_act') });
        return;
      }
      r.pendingAct = undefined;
    }
    if (session.turns >= this.pace(live).sessionTurns) return this.endSession(live, 'why_turns');
    if (num(arr(at(live.obs, 'you', 'ap'))[0]) < this.cfg.ap.stopBelow) return this.endSession(live, 'why_ap');
    const doc = await this.schemaDoc(r.server);
    const turnStart = this.now;
    const turn = this.brain.buildTurn(doc, {
      character: this.character_(live),
      observation: live.obs,
      me: live.me,
      last: session.last,
      events: session.events,
      memory: live.memory,
      command: r.command && r.command.turnsLeft > 0 ? r.command.text : '',
    });
    if (turn.menu.actions.length === 0) return this.endSession(live, 'why_none');
    live.thinking = true;
    this.emitCharacter(live);
    const schema = turn.menu.schema;
    const maxTokens = this.cfg.sampling.maxTokens;
    let inferMs = 0;
    let first: Completion;
    try {
      first = await this.infer(turn.messages, schema, maxTokens, PRIORITY.turn, signal);
    } catch (e) {
      // The engine refused the request itself (an unsupported schema feature): ask once without the constraint; the
      // answer is validated against the same menu all the same.
      if (!engineRefused(e) || signal.aborted) throw e;
      r.stats.unconstrained++;
      first = await this.infer(turn.messages, undefined, maxTokens, PRIORITY.turn, signal);
    }
    inferMs += first.ms;
    let tokens = first.tokens;
    const res = await this.brain.resolve(turn.menu, first.text, async (problem) => {
      const second = await this.infer(this.brain.retryMessages(turn.messages, first.text, problem), schema, maxTokens, PRIORITY.turn, signal);
      inferMs += second.ms;
      tokens += second.tokens;
      return second.text;
    });
    live.thinking = false;
    if (signal.aborted || !r.run) return;
    r.stats.tokens += tokens;
    if (res.source === 'none' || !res.decision) return this.endSession(live, 'why_none');
    if (res.source === 'fallback') await this.writeLog(live, { kind: 'system', text: this.t('fallback') });
    const d: Decision = res.decision;
    // Enforced by the per-turn schema, and once more here before anything is sent (core-api.ts, `allowPvp`).
    if (!r.directives.allowPvp && pvpViolation(this.brain.kit, d, live.obs, live.me, r.name)) {
      await this.writeLog(live, { kind: 'system', text: this.t('pvp_refused') });
      return this.endSession(live, 'why_none');
    }
    const pending: PendingAct = { idemKey: this.ids.opaque('t_', 24), action: d.action, paramsJson: write(d.params), thought: this.redactor.scrub(d.thought), note: d.note, at: this.now };
    r.pendingAct = pending;
    await this.save(live);
    await this.sendAct(live, pending, res.source, inferMs, turnStart);
  }

  /** POST /act and everything that follows it (README 6.1 step 2, after the decision). */
  private async sendAct(live: Live, p: PendingAct, source: 'first' | 'retry' | 'fallback' | null, inferMs: number, turnStart: number): Promise<void> {
    const r = live.rec;
    const session = live.session!;
    let params: JV;
    try {
      params = parse(p.paramsJson);
    } catch {
      params = obj();
    }
    // Once decided, the request is not cancelled by a pause: the action finishes and is logged.
    const body = this.fromGame(await this.client(r.server).act(vaultNames.agentKey(r.id), p.action, params, p.idemKey));
    r.pendingAct = undefined;
    const ok = get(body, 'ok') === true;
    const prevYou = get(live.obs, 'you');
    const st = r.stats;
    st.turns++;
    st.inferMs += inferMs;
    if (source === 'first') st.firstValid++;
    else if (source === 'retry') st.retried++;
    else if (source === 'fallback') st.fallbacks++;
    let last: Last;
    let gerr: GameErr | undefined;
    let narration = '';
    if (ok) {
      st.accepted++;
      live.obs = mergeObs(live.obs, body, false);
      if (has(body, 'room')) this.brain.observe(live.memory.world, live.obs);
      const cur = get(live.obs, 'you');
      narration = text(get(body, 'narration'));
      const delta: NonNullable<LogEntry['delta']> = {};
      const away = r.away;
      const g = xpGain(prevYou, cur);
      if (g !== 0) {
        delta.xp = g;
        away.xp += g;
        if ((p.action === 'attack' || p.action === 'cast') && g > 0) away.kills++;
      }
      const gold = Math.trunc(num(get(cur, 'gold')) - num(get(prevYou, 'gold')));
      if (gold !== 0) {
        delta.gold = gold;
        away.gold += gold;
      }
      const hp = Math.trunc(gauge(get(cur, 'hp'), [0, 0])[0] - gauge(get(prevYou, 'hp'), [0, 0])[0]);
      if (hp !== 0) delta.hp = hp;
      let big = false;
      const levels = Math.trunc(num(get(cur, 'lvl')) - num(get(prevYou, 'lvl')));
      if (levels > 0 && isObj(prevYou)) {
        // As the desktop core reports it: the new level, not the difference.
        delta.level = num(get(cur, 'lvl'));
        away.levels += levels;
        this.addHighlight(live, this.t('level_up', { level: delta.level }));
        big = true;
      }
      if (has(cur, 'fallen') && !has(prevYou, 'fallen')) {
        away.deaths++;
        big = true;
      }
      away.actions++;
      await this.writeLog(live, { kind: 'action', text: narration, action: p.action, ...(p.thought ? { thought: p.thought } : {}), ...(Object.keys(delta).length ? { delta } : {}), ...(big ? { big: true } : {}) });
      last = { action: p.action, params, ok: true, narration, ...(has(body, 'data') ? { data: get(body, 'data')! } : {}) };
    } else {
      st.refused++;
      const e = get(body, 'error');
      const hint = text(get(e, 'hint'));
      gerr = { code: text(get(e, 'code')), message: text(get(e, 'message')), ...(hint ? { hint } : {}) };
      await this.writeLog(live, { kind: 'refused', text: [gerr.message, hint].filter(Boolean).join(' '), action: p.action, ...(p.thought ? { thought: p.thought } : {}) });
      last = { action: p.action, params, ok: false, error: gerr };
    }
    const cur = text(get(body, 'cursor'));
    if (cur) r.cursor = cur;
    const heard = this.brain.heard(get(body, 'messages'));
    for (const m of arr(get(body, 'messages'))) await this.logMessage(live, m);
    const needCompact = this.brain.remember(live.memory, this.brain.recentOf(p.action, params, ok, ok ? narration : '', gerr), p.note, heard.chat);
    if (r.command && r.command.turnsLeft > 0 && --r.command.turnsLeft === 0) r.command = undefined;
    if (needCompact) await this.compact(live);
    if (ok && this.brain.refreshesMe(p.action)) await this.client(r.server).me(vaultNames.agentKey(r.id)).then((me) => this.takeMe(live, this.fromGame(me)), () => undefined);
    session.turns++;
    session.last = last;
    session.events = heard.events;
    this.updateSnapshot(live);
    st.turnMs += Math.max(0, this.now - turnStart);
    const cooldown = !ok && gerr?.code === 'COOLDOWN';
    this.wait(live, cooldown ? this.cfg.requests.cooldownWaitSeconds * 1000 : this.cfg.requests.turnGapMs, cooldown ? 'cooldown' : undefined);
  }

  /** README 5.4: merge the notes; on any failure keep the newest. */
  private async compact(live: Live): Promise<void> {
    const t = this.brain.compactionTurn(live.rec.name, live.memory.notes);
    try {
      const c = await this.infer(t.messages, t.schema, COMPACTION_TOKENS, PRIORITY.memory, live.ctrl?.signal);
      live.memory.notes = this.brain.applyCompaction(c.text, live.memory.notes).map((n) => this.redactor.scrub(n));
      live.rec.stats.compactions++;
      await this.writeLog(live, { kind: 'system', text: this.t('memory') });
    } catch {
      live.memory.notes = this.brain.applyCompaction('', live.memory.notes);
    }
  }
}

/** Game codes the contract renames; any other keeps the game's own code. */
function gameCode(code: string): string {
  if (code === 'NAME_INVALID') return FAULT.invalidName;
  return code;
}

