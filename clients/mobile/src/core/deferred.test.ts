import { describe, expect, it } from 'vitest';
import { deferredCore } from './deferred';
import type { Core, CoreEvent } from './types';

function resolvable<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('deferredCore', () => {
  it('waits for the real core, then forwards calls and subscriptions', async () => {
    const d = resolvable<Core>();
    const core = deferredCore(d.promise);
    const got: CoreEvent[] = [];
    const stop = core.subscribe((ev) => got.push(ev));
    const pending = core.settings();
    let emit: (ev: CoreEvent) => void = () => {};
    d.resolve({
      settings: async () => ({ serverUrl: 'https://game.example', language: 'en' }),
      subscribe: (l: (ev: CoreEvent) => void) => {
        emit = l;
        return () => {
          emit = () => {};
        };
      },
    } as unknown as Core);
    expect(await pending).toEqual({ serverUrl: 'https://game.example', language: 'en' });
    emit({ type: 'removed', id: 'c1' });
    stop();
    emit({ type: 'removed', id: 'c2' });
    expect(got).toEqual([{ type: 'removed', id: 'c1' }]);
  });

  it('rejects every call when the core could not be created', async () => {
    const d = resolvable<Core>();
    const core = deferredCore(d.promise);
    const stop = core.subscribe(() => {});
    d.reject(new Error('no database'));
    await expect(core.state()).rejects.toThrow('no database');
    stop();
  });

  it('is not mistaken for a promise', () => {
    const core = deferredCore(new Promise<Core>(() => {}));
    expect((core as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
