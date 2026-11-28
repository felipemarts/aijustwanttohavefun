/**
 * The in-app core for Android and iOS: `LocalCore` from `@ajwf/client-core`, with every port on a native module.
 * Metro picks this file on native platforms only; the web bundle gets create-local.ts and none of these libraries.
 */
import { LocalCore, type Ports } from '@ajwf/client-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import Constants from 'expo-constants';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync } from 'expo-sqlite';
import { fetch as expoFetch } from 'expo/fetch';
import { initLlama } from 'llama.rn';
import { verifyProgress } from '../state/verify';
import { expoFsApi } from './native/expo-fs';
import { expoModelFiles } from './native/files';
import { llamaRuntime, type InitLlama } from './native/runtime';
import { sqliteStorage } from './native/storage';
import { secureStoreVault } from './native/vault';
import type { Core } from './types';

export async function createLocalCore(language: string): Promise<Core> {
  const ports: Ports = {
    vault: secureStoreVault(SecureStore),
    storage: await sqliteStorage(await openDatabaseAsync('ajwf-player.db')),
    files: expoModelFiles({
      fs: expoFsApi(),
      sha256: () => {
        const h = sha256.create();
        return { update: (c) => void h.update(c), hex: () => bytesToHex(h.digest()) };
      },
      onVerify: (name, done, total) => verifyProgress.report(name, done, total),
    }),
    runtime: llamaRuntime(initLlama as unknown as InitLlama),
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
    },
    // expo/fetch honours `redirect: 'manual'` natively (OkHttp followRedirects(false); URLSession declines the redirect)
    // and returns the 3xx answer, which the core relies on to never carry a credential to another host.
    fetch: (input, init) => expoFetch(input, init as Parameters<typeof expoFetch>[1]) as unknown as Promise<Response>,
    random: (n) => getRandomBytes(n),
  };
  const server = process.env.EXPO_PUBLIC_GAME_SERVER;
  return LocalCore.create({
    ports,
    platform: 'mobile',
    version: Constants.expoConfig?.version,
    defaults: server ? { serverUrl: server.replace(/\/+$/, ''), language } : { language },
  });
}
