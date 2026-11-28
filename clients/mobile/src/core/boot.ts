/**
 * Builds the core once, at startup, before the router reads the URL (so the token fragment is gone by then).
 */
import { Platform } from 'react-native';
import { chooseCore, type CoreKind } from './choose';
import { createLocalCore } from './create-local';
import { deferredCore } from './deferred';
import { MockCore } from './mock/mock-core';
import { resolveLanguage } from '../i18n/i18n';
import { RemoteCore } from './remote';
import { takeSessionToken } from './session';
import type { Core } from './types';

export type Boot = { kind: CoreKind; core: Core };

function deviceLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

function boot(): Boot {
  let token: string | null = null;
  let search = '';
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const loc = window.location;
    search = loc.search;
    token = takeSessionToken(loc, (url) => window.history.replaceState(null, '', url));
  }
  const kind = chooseCore({ os: Platform.OS, search, flag: process.env.EXPO_PUBLIC_CORE });
  switch (kind) {
    case 'remote':
      return { kind, core: new RemoteCore({ base: window.location.origin, token }) };
    case 'mock':
    case 'mock-empty':
      return {
        kind,
        core: new MockCore({
          empty: kind === 'mock-empty',
          language: new URLSearchParams(search).get('lang') || deviceLanguage(),
          engineOff: new URLSearchParams(search).get('engine') === 'off',
          stuckDemo: new URLSearchParams(search).get('stuck') === '1',
        }),
      };
    default:
      // Android and iOS: the in-app core, created asynchronously (database, keychain, playkit); usable at once.
      return { kind, core: deferredCore(createLocalCore(resolveLanguage(deviceLanguage()))) };
  }
}

export const BOOT: Boot = boot();
