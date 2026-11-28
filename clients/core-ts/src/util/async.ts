import type { Clock } from '../ports.ts';
import { abortError } from './errors.ts';

/** Waits `ms` on the core's clock; rejects with an AbortError if `signal` aborts first. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      t.cancel();
      reject(abortError());
    };
    const t = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An AbortController that aborts after `ms` on the core's clock or when `parent` aborts. `timedOut` tells the two
 * apart. Call `done()` when the guarded work finishes.
 */
export function deadline(clock: Clock, ms: number, parent?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctrl = new AbortController();
  let timed = false;
  const t = clock.setTimeout(() => {
    timed = true;
    ctrl.abort();
  }, ms);
  const onParent = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => timed,
    done: () => {
      t.cancel();
      parent?.removeEventListener('abort', onParent);
    },
  };
}

type Waiter = { priority: number; seq: number; grant: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void };

/**
 * One holder at a time, waiters served by priority (higher first) then arrival. The core holds it around every
 * model call, so only one inference runs across all characters, and an owner's chat jumps ahead of the turns.
 */
export class PriorityLock {
  private held = false;
  private seq = 0;
  private queue: Waiter[] = [];

  get busy(): boolean {
    return this.held;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(priority: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(priority, signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(priority: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w: Waiter = { priority, seq: this.seq++, grant: resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.queue = this.queue.filter((x) => x !== w);
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.queue.push(w);
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.held = false;
      return;
    }
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    next.grant();
  }
}

/** Serializes async work per key (one storage writer per character, one turn per character). */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
