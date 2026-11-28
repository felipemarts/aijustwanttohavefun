/**
 * A `Core` usable at once while the real one is still being created (LocalCore opens its database, reads the keychain
 * and loads the playkit asynchronously). Every call waits for it; a failed creation rejects every call with that error,
 * so the interface shows it instead of hanging.
 */
import type { Core, CoreEvent } from './types';

export function deferredCore(pending: Promise<Core>): Core {
  const call =
    <K extends keyof Core>(name: K) =>
    async (...args: unknown[]) => {
      const core = await pending;
      return (core[name] as (...a: unknown[]) => unknown)(...args);
    };
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'subscribe') {
        return (listener: (ev: CoreEvent) => void) => {
          let stop: (() => void) | null = null;
          let stopped = false;
          void pending.then(
            (core) => {
              if (!stopped) stop = core.subscribe(listener);
            },
            () => undefined,
          );
          return () => {
            stopped = true;
            stop?.();
          };
        };
      }
      if (prop === 'then') return undefined; // not a thenable
      return call(prop as keyof Core);
    },
  };
  return new Proxy({}, handler) as Core;
}
