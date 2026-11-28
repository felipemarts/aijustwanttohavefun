/** In-memory ports and a controllable clock, for tests (here and in the app). Platform-neutral. */
import type { Clock, DownloadRequest, KeyVault, ModelFiles, ModelRuntime, RuntimeRequest, Storage, TimerHandle } from '../ports.ts';
import { abortError } from '../util/errors.ts';

export class MemoryKeyVault implements KeyVault {
  readonly data = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.data.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.data.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.data.delete(name);
  }
}

export class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(prefix: string, opts: { before?: string; after?: string; limit?: number; reverse?: boolean } = {}): Promise<{ key: string; value: string }[]> {
    let keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (opts.before !== undefined) keys = keys.filter((k) => k < opts.before!);
    if (opts.after !== undefined) keys = keys.filter((k) => k > opts.after!);
    if (opts.reverse) keys.reverse();
    if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
    return keys.map((key) => ({ key, value: this.data.get(key)! }));
  }
}

type Timer = { at: number; seq: number; fn: () => void; cancelled: boolean };

/** Time moves only when a test says so. `advance` fires due timers in order and lets their async work settle. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = Date.UTC(2026, 10, 27, 12, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Pending timers (not cancelled). */
  get pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /** The time of the next timer, if any. */
  next(): number | undefined {
    const live = this.timers.filter((t) => !t.cancelled);
    return live.length ? Math.min(...live.map((t) => t.at)) : undefined;
  }

  /** Lets promise chains and real macrotasks run (each round yields to the event loop). */
  async settle(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => globalThis.setTimeout(r, 0));
  }

  /** Moves time forward by `ms`, firing every timer that falls due, in order, settling after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await this.settle();
    for (;;) {
      this.timers = this.timers.filter((t) => !t.cancelled);
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await this.settle();
    }
    this.t = target;
    await this.settle();
  }

  /** Jumps the clock without firing anything (simulates time passing while the app is closed). */
  jump(ms: number): void {
    this.t += ms;
  }
}

/** Model files in memory: `download` "receives" bytes in chunks, honours resume, abort, size and a fake checksum. */
export class MemoryModelFiles implements ModelFiles {
  free = 64 * 1024 ** 3;
  readonly present = new Map<string, { bytes: number; complete: boolean }>();
  /** Bytes per progress step. */
  chunk = 256 * 1024 ** 2;
  /** Set to make the next download fail mid-way (after this many bytes). */
  failAt: number | null = null;
  /** Waits between chunks; tests resolve it to step a download. */
  gate: (() => Promise<void>) | null = null;
  requests: DownloadRequest[] = [];

  async freeBytes(): Promise<number> {
    return this.free;
  }
  async stat(name: string): Promise<{ bytes: number; complete: boolean } | null> {
    return this.present.get(name) ?? null;
  }
  async path(name: string): Promise<string | null> {
    return this.present.get(name)?.complete ? `/private/app/models/${name}` : null;
  }
  async remove(name: string): Promise<void> {
    this.present.delete(name);
  }
  async download(req: DownloadRequest): Promise<{ path: string }> {
    this.requests.push(req);
    const cur = this.present.get(req.name) ?? { bytes: 0, complete: false };
    this.present.set(req.name, cur);
    while (cur.bytes < req.bytes) {
      if (this.gate) {
        const signal = req.signal;
        await Promise.race([
          this.gate(),
          new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      if (req.signal?.aborted) throw abortError();
      if (this.failAt !== null && cur.bytes >= this.failAt) {
        this.failAt = null;
        throw new Error(`disk error writing /private/app/models/${req.name}.part`);
      }
      cur.bytes = Math.min(req.bytes, cur.bytes + this.chunk);
      req.onProgress?.(cur.bytes, req.bytes);
    }
    cur.complete = true;
    return { path: `/private/app/models/${req.name}` };
  }
}

/** A model runtime whose answers come from a script: a function of the request. */
export class FakeRuntime implements ModelRuntime {
  private path: string | null = null;
  calls: RuntimeRequest[] = [];
  loads = 0;
  answer: (req: RuntimeRequest) => string;
  constructor(answer: (req: RuntimeRequest) => string = () => '{}') {
    this.answer = answer;
  }
  async load(path: string): Promise<void> {
    this.loads++;
    this.path = path;
  }
  loaded(): string | null {
    return this.path;
  }
  async complete(req: RuntimeRequest): Promise<{ text: string; tokens: number }> {
    if (req.signal?.aborted) throw abortError();
    this.calls.push(req);
    const text = this.answer(req);
    for (const piece of text.match(/.{1,4}/gs) ?? []) req.onToken?.(piece);
    return { text, tokens: Math.max(1, Math.ceil(text.length / 4)) };
  }
  async unload(): Promise<void> {
    this.path = null;
  }
}
