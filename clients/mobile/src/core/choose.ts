/**
 * The one place that decides which core the interface talks to.
 *   - web (served by the desktop program): `RemoteCore`, which trades the URL fragment's one-time token for a
 *     session cookie, or reuses the cookie after a reload (the interface says "open from the desktop app" only
 *     when the program answers unauthorized);
 *   - web with `?mock=1` (or `?mock=empty`), or any platform built with `EXPO_PUBLIC_CORE=mock`: `MockCore`;
 *   - Android and iOS: `LocalCore` (a stub until the on-device core is ported).
 * Kept free of React Native imports so it can be unit-tested.
 */
export type CoreKind = 'remote' | 'mock' | 'mock-empty' | 'local';

export function chooseCore(input: { os: string; search: string; flag?: string }): CoreKind {
  const flag = (input.flag ?? '').trim().toLowerCase();
  if (flag === 'mock') return 'mock';
  if (flag === 'mock-empty') return 'mock-empty';
  if (input.os === 'web') {
    const mock = new URLSearchParams(input.search).get('mock');
    if (mock === 'empty') return 'mock-empty';
    if (mock === '1' || mock === 'true') return 'mock';
    return 'remote';
  }
  return 'local';
}
