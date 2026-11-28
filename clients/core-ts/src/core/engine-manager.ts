/**
 * The engine the characters think with: the owner's choice, its live status, the built-in model's download, and the
 * provider key (bound to the address it was entered for).
 */
import type { EngineChoice, EngineState, EngineTest, ProviderInfo, ProviderKind } from '../api.ts';
import { BuiltinEngine } from '../engine/builtin.ts';
import { parseJson, request, type BoundKey, type HttpDeps } from '../engine/http.ts';
import { isPinned, type BuiltinModel } from '../engine/model.ts';
import { OllamaEngine } from '../engine/ollama.ts';
import { OpenAiEngine } from '../engine/openai.ts';
import { EngineError, type ConstraintMode, type Engine, type LlmMessage } from '../engine/types.ts';
import type { Clock, Fetch, KeyVault, ModelFiles, ModelRuntime } from '../ports.ts';
import { CoreFault, FAULT, isAbort } from '../util/errors.ts';
import { extract, validateSchema } from '../playkit/decide.ts';
import { fromPlain } from '../playkit/jv.ts';
import type { Kit } from '../playkit/kit.ts';
import type { Redactor } from '../util/redact.ts';
import { normalizeBaseUrl, originOf } from '../util/url.ts';
import { vaultNames, type EngineRecord, type Repo } from './store.ts';

/** LM Studio is recognised by its own model list (`/api/v1/models`), not by the OpenAI route every server has. */
class LmStudioProbe extends OpenAiEngine {
  private readonly probeBase: string;
  private readonly probeDeps: HttpDeps;
  constructor(url: string, deps: HttpDeps) {
    super('lmstudio', url, undefined, deps);
    this.probeBase = url.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.probeDeps = deps;
  }
  override async listModels(signal?: AbortSignal): Promise<string[]> {
    const a = await request(this.probeDeps, `${this.probeBase}/api/v1/models`, { method: 'GET', signal, timeoutMs: this.probeDeps.probeTimeoutMs });
    const j = a.status === 200 ? (parseJson(a.text) as { models?: { key?: unknown; type?: unknown }[] } | undefined) : undefined;
    if (!Array.isArray(j?.models)) throw new EngineError('bad_response', 'Not LM Studio.');
    return j.models.filter((m) => m.type === 'llm' && typeof m.key === 'string').map((m) => m.key as string);
  }
}

export const DEFAULT_URLS: Record<Exclude<ProviderKind, 'builtin'>, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  openai: 'http://127.0.0.1:8080',
};

const LABELS: Record<ProviderKind, string> = { builtin: 'Built-in', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI-compatible server' };

/** Free space kept beyond the model's size, so the phone is not filled to the last byte. */
const SPACE_MARGIN = 200 * 1024 * 1024;
const PROBE_TTL = 15_000;
const DOWNLOAD_FAILED = 'The model download failed; it can be resumed.';

export type EngineDeps = {
  repo: Repo;
  vault: KeyVault;
  files: ModelFiles;
  runtime: ModelRuntime;
  clock: Clock;
  fetch: Fetch;
  redactor: Redactor;
  model: BuiltinModel;
  emit: (s: EngineState) => void;
  /** Runs a model call under the core's inference lock. */
  withLock: <T>(priority: number, fn: () => Promise<T>) => Promise<T>;
  /** The playkit (sampling). */
  kit: Kit;
  /** Longest wait for one completion from an external server. */
  timeoutMs?: number;
};

const TEST_SCHEMA = fromPlain({
  type: 'object',
  properties: { greeting: { type: 'string', maxLength: 80 }, ready: { type: 'boolean' } },
  required: ['greeting', 'ready'],
  additionalProperties: false,
});

export class EngineManager {
  private d: EngineDeps;
  private rec: EngineRecord = { kind: 'builtin' };
  private current: Engine | null = null;
  private builtin: BuiltinEngine;
  private status: EngineState['status'] = 'not_installed';
  private message: string | undefined;
  private tps: number | undefined;
  private probedAt = -Infinity;
  private download: { ctrl: AbortController; done: number; promise: Promise<void> } | null = null;
  private partialBytes = 0;
  /** The last download failed (kept until the next start, so the owner sees why). */
  private downloadFailed = false;

  constructor(d: EngineDeps) {
    this.d = d;
    this.builtin = new BuiltinEngine(d.model, d.files, d.runtime, d.clock, (p) => d.redactor.add(p));
  }

  async init(): Promise<void> {
    this.rec = (await this.d.repo.engine()) ?? { kind: 'builtin' };
    this.current = this.build(this.rec);
    await this.refresh(true);
  }

  get choice(): EngineRecord {
    return this.rec;
  }

  get engine(): Engine | null {
    return this.status === 'ready' ? this.current : null;
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  state(): EngineState {
    const { mode: _mode, ...choice } = this.rec;
    const m = this.d.model;
    return {
      choice,
      // A running download is shown whatever the choice; characters go by the chosen engine's own status.
      status: this.download ? 'downloading' : this.status,
      builtin: { model: m.name, file: m.file, licenseName: m.licenseName, licenseUrl: m.licenseUrl, bytesTotal: m.bytes, bytesDone: this.download ? this.download.done : this.partialBytes },
      ...(this.message ? { message: this.message } : {}),
      ...(this.tps !== undefined ? { tokensPerSecond: Math.round(this.tps * 10) / 10 } : {}),
    };
  }

  private set(status: EngineState['status'], message?: string): void {
    const changed = status !== this.status || message !== this.message;
    this.status = status;
    this.message = message;
    if (changed) this.d.emit(this.state());
  }

  private httpDeps(): HttpDeps {
    return {
      fetch: this.d.fetch,
      clock: this.d.clock,
      ...(this.d.timeoutMs ? { timeoutMs: this.d.timeoutMs } : {}),
      apiKey: async () => {
        const raw = await this.d.vault.get(vaultNames.engineKey);
        if (!raw) return null;
        try {
          const b = JSON.parse(raw) as BoundKey;
          this.d.redactor.add(b.key);
          return b;
        } catch {
          return null;
        }
      },
    };
  }

  private build(rec: EngineRecord, mode?: ConstraintMode): Engine {
    if (rec.kind === 'builtin') return this.builtin;
    const url = rec.url ?? DEFAULT_URLS[rec.kind];
    if (rec.kind === 'ollama') return new OllamaEngine(url, rec.model, this.httpDeps());
    return new OpenAiEngine(rec.kind, url, rec.model, this.httpDeps(), mode ?? rec.mode);
  }

  /** Re-reads the status: the built-in file every time (a stat), an external server at most every 15 s unless forced. */
  async refresh(force = false): Promise<EngineState> {
    if (this.download && this.rec.kind === 'builtin') return this.state();
    const now = this.d.clock.now();
    if (!force && this.rec.kind !== 'builtin' && now - this.probedAt < PROBE_TTL) return this.state();
    this.probedAt = now;
    if (this.rec.kind === 'builtin') {
      const st = await this.d.files.stat(this.d.model.file).catch(() => null);
      this.partialBytes = st?.complete ? this.d.model.bytes : (st?.bytes ?? 0);
      if (st?.complete) this.set('ready');
      else if (this.downloadFailed) this.set('error', DOWNLOAD_FAILED);
      else this.set('not_installed', isPinned(this.d.model) ? undefined : 'The built-in model is not pinned in this build yet.');
      return this.state();
    }
    const p = await this.current!.probe();
    if (!p.reachable) this.set('unreachable', 'The AI server does not answer.');
    else if (!p.models.length) this.set('error', p.message ?? 'The AI server has no model available.');
    else if (this.rec.model && !p.models.includes(this.rec.model)) this.set('error', 'The chosen model is not on that server.');
    else this.set('ready');
    return this.state();
  }

  /** After a real failure: mark it so characters wait, and re-probe soon. */
  noteFailure(e: unknown): void {
    if (e instanceof EngineError && (e.code === 'unreachable' || e.code === 'timeout')) this.set('unreachable', 'The AI server does not answer.');
    else if (e instanceof EngineError && e.code === 'not_installed') this.set('not_installed');
    else this.set('error', e instanceof EngineError ? e.message : 'The AI engine failed.');
    this.probedAt = -Infinity;
  }

  noteSpeed(tokens: number, ms: number): void {
    if (tokens > 0 && ms > 0) {
      const tps = tokens / (ms / 1000);
      this.tps = this.tps === undefined ? tps : this.tps * 0.7 + tps * 0.3;
    }
  }

  /** Remembers the constraint mode an external server accepted, so a restart does not probe the fallbacks again. */
  async rememberMode(): Promise<void> {
    const m = (this.current as { mode?: ConstraintMode } | null)?.mode;
    if (this.rec.kind !== 'builtin' && m && m !== this.rec.mode) {
      this.rec = { ...this.rec, mode: m };
      await this.d.repo.saveEngine(this.rec);
    }
  }

  async setChoice(choice: EngineChoice): Promise<EngineState> {
    const kinds: ProviderKind[] = ['builtin', 'ollama', 'lmstudio', 'openai'];
    if (!choice || !kinds.includes(choice.kind)) throw new CoreFault(FAULT.invalid, 'Unknown engine kind.');
    const model = typeof choice.model === 'string' && choice.model.trim() ? choice.model.trim().slice(0, 200) : undefined;
    let rec: EngineRecord;
    if (choice.kind === 'builtin') rec = { kind: 'builtin' };
    else {
      const url = normalizeBaseUrl(choice.url ?? DEFAULT_URLS[choice.kind], 'AI server address');
      rec = { kind: choice.kind, url, ...(model ? { model } : {}) };
    }
    // The provider key is bound to the address it was entered with; a key for another address is dropped.
    const existing = await this.d.vault.get(vaultNames.engineKey);
    let bound: BoundKey | null;
    try {
      bound = existing ? (JSON.parse(existing) as BoundKey) : null;
    } catch {
      bound = null;
    }
    if (typeof choice.apiKey === 'string' && choice.apiKey !== '') {
      if (!rec.url) throw new CoreFault(FAULT.invalid, 'A key needs a server address.');
      if (choice.apiKey.length > 4096) throw new CoreFault(FAULT.invalid, 'The key is too long.');
      this.d.redactor.add(choice.apiKey);
      bound = { origin: originOf(rec.url), key: choice.apiKey };
      await this.d.vault.set(vaultNames.engineKey, JSON.stringify(bound));
    } else if (choice.apiKey === '' || (bound && (!rec.url || bound.origin !== originOf(rec.url)))) {
      await this.d.vault.delete(vaultNames.engineKey);
      bound = null;
    }
    if (bound) rec.hasApiKey = true;
    if (this.rec.kind === 'builtin' && rec.kind !== 'builtin') await this.builtin.unload().catch(() => undefined);
    this.rec = rec;
    await this.d.repo.saveEngine(rec);
    this.current = this.build(rec, 'schema');
    this.tps = undefined;
    return this.refresh(true);
  }

  /** The built-in model plus Ollama and LM Studio at their usual addresses (and the chosen address, if another). */
  async providers(): Promise<ProviderInfo[]> {
    const out: ProviderInfo[] = [];
    const b = await this.builtin.probe();
    out.push({ kind: 'builtin', label: `${LABELS.builtin}: ${this.d.model.name}`, reachable: b.reachable, models: b.models });
    const targets: { kind: Exclude<ProviderKind, 'builtin'>; url: string }[] = [
      { kind: 'ollama', url: DEFAULT_URLS.ollama },
      { kind: 'lmstudio', url: DEFAULT_URLS.lmstudio },
    ];
    if (this.rec.kind !== 'builtin' && this.rec.url && !targets.some((t) => t.kind === this.rec.kind && t.url === this.rec.url)) {
      targets.push({ kind: this.rec.kind, url: this.rec.url });
    }
    const probes = await Promise.all(
      targets.map(async (t) => {
        const e = this.build({ kind: t.kind, url: t.url, ...(t.url === this.rec.url && this.rec.model ? { model: this.rec.model } : {}) });
        const p = await e.probe().catch(() => ({ reachable: false, models: [] as string[] }));
        return { kind: t.kind, label: LABELS[t.kind], url: t.url, reachable: p.reachable, models: p.models } satisfies ProviderInfo;
      }),
    );
    return [...out, ...probes];
  }

  /**
   * What answers at one address the owner typed: Ollama, LM Studio or another OpenAI-compatible server, tried in
   * that order with a short timeout. The address is validated (http or https), redirects to another host are
   * refused, and the provider key is sent only if it was entered for this very address.
   */
  async probeProvider(input: string): Promise<ProviderInfo> {
    const url = normalizeBaseUrl(input, 'AI server address');
    const deps = { ...this.httpDeps(), probeTimeoutMs: 2_500 };
    const tries: { kind: Exclude<ProviderKind, 'builtin'>; engine: Engine }[] = [
      { kind: 'ollama', engine: new OllamaEngine(url, undefined, deps) },
      { kind: 'lmstudio', engine: new LmStudioProbe(url, deps) },
      { kind: 'openai', engine: new OpenAiEngine('openai', url, undefined, deps) },
    ];
    let reachable = false;
    for (const t of tries) {
      try {
        const models = await t.engine.listModels();
        return { kind: t.kind, label: LABELS[t.kind], url, reachable: true, models };
      } catch (e) {
        const down = !(e instanceof EngineError) || e.code === 'unreachable' || e.code === 'timeout' || e.code === 'redirect';
        // Nothing answers there at all: the other kinds would not either.
        if (down && !reachable) break;
        if (!down) reachable = true;
      }
    }
    return { kind: 'openai', label: LABELS.openai, url, reachable, models: [] };
  }

  // ── Built-in model download ─────────────────────────────────────────────────────────────────────────────────

  async startDownload(): Promise<EngineState> {
    const m = this.d.model;
    if (this.download) return this.state();
    if (!isPinned(m)) throw new CoreFault(FAULT.engine, 'The built-in model is not pinned in this build yet.');
    const st = await this.d.files.stat(m.file).catch(() => null);
    if (st?.complete) {
      this.partialBytes = m.bytes;
      if (this.rec.kind === 'builtin') this.set('ready');
      return this.state();
    }
    const have = st?.bytes ?? 0;
    const free = await this.d.files.freeBytes();
    if (free < m.bytes - have + SPACE_MARGIN) throw new CoreFault(FAULT.noSpace, 'Not enough free space for the model.');
    const ctrl = new AbortController();
    let lastEmit = -Infinity;
    let lastPct = -1;
    const dl = {
      ctrl,
      done: have,
      promise: Promise.resolve(),
    };
    this.download = dl;
    this.downloadFailed = false;
    if (this.rec.kind === 'builtin') this.message = undefined;
    this.d.emit(this.state());
    dl.promise = this.d.files
      .download({
        url: m.url,
        name: m.file,
        bytes: m.bytes,
        sha256: m.sha256,
        signal: ctrl.signal,
        onProgress: (done) => {
          dl.done = done;
          const pct = Math.floor((done / m.bytes) * 100);
          const now = this.d.clock.now();
          if (pct !== lastPct || now - lastEmit >= 1000) {
            lastPct = pct;
            lastEmit = now;
            this.d.emit(this.state());
          }
        },
      })
      .then(
        () => {
          this.download = null;
          this.partialBytes = m.bytes;
          if (this.rec.kind === 'builtin') this.set('ready');
          else this.d.emit(this.state());
        },
        async (e: unknown) => {
          this.download = null;
          const st2 = await this.d.files.stat(m.file).catch(() => null);
          this.partialBytes = st2?.bytes ?? 0;
          // Never pass the port's error text on: it may name a file path.
          const failed = !isAbort(e);
          this.downloadFailed = failed;
          if (this.rec.kind === 'builtin') this.set(failed ? 'error' : 'not_installed', failed ? DOWNLOAD_FAILED : undefined);
          else this.d.emit(this.state());
        },
      );
    return this.state();
  }

  /** Stops the download and keeps the partial file for a later resume. */
  async pauseDownload(): Promise<EngineState> {
    const dl = this.download;
    if (dl) {
      dl.ctrl.abort();
      await dl.promise;
    }
    return this.state();
  }

  /** Stops the download and deletes what was downloaded. */
  async cancelDownload(): Promise<EngineState> {
    await this.pauseDownload();
    const st = await this.d.files.stat(this.d.model.file).catch(() => null);
    if (!st?.complete) {
      await this.d.files.remove(this.d.model.file).catch(() => undefined);
      this.partialBytes = 0;
    }
    if (this.rec.kind === 'builtin') this.set(st?.complete ? 'ready' : 'not_installed');
    else this.d.emit(this.state());
    return this.state();
  }

  /** Waits for a running download (tests and the harness). */
  async downloadSettled(): Promise<void> {
    await this.download?.promise;
  }

  // ── Test ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async test(): Promise<EngineTest> {
    await this.refresh(true);
    const engine = this.current;
    if (!engine || this.status !== 'ready') return { ok: false, tokensPerSecond: 0, validJson: false, sample: '', message: this.message ?? 'The AI engine is not ready.' };
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are a character in a fantasy game. Answer with JSON only.' },
      { role: 'user', content: 'Greet your owner in one short sentence and say whether you are ready to play.' },
    ];
    try {
      const sm = this.d.kit.config.sampling;
      const r = await this.d.withLock(5, () => engine.complete(messages, { schema: TEST_SCHEMA, maxTokens: 80, temperature: sm.temperature, topK: sm.topK, repeatPenalty: sm.repeatPenalty }));
      const tps = r.tokens / Math.max(0.001, r.ms / 1000);
      this.noteSpeed(r.tokens, r.ms);
      await this.rememberMode();
      const parsed = extract(this.d.kit, r.text);
      const validJson = 'value' in parsed && validateSchema(parsed.value, TEST_SCHEMA, 'answer') === '';
      this.d.emit(this.state());
      return {
        ok: validJson,
        tokensPerSecond: Math.round(tps * 10) / 10,
        validJson,
        sample: this.d.redactor.scrub(r.text).slice(0, 300),
        ...(validJson ? {} : { message: 'The engine answered, but not with valid JSON.' }),
        ...(r.mode !== 'schema' ? { message: `The server does not enforce JSON Schema; using ${r.mode === 'json' ? 'JSON mode' : 'no constraint'} instead (answers are still validated).` } : {}),
      };
    } catch (e) {
      this.noteFailure(e);
      return { ok: false, tokensPerSecond: 0, validJson: false, sample: '', message: e instanceof EngineError ? e.message : 'The AI engine failed.' };
    }
  }
}
