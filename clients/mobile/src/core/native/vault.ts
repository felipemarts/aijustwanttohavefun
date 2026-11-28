/**
 * `KeyVault` on expo-secure-store (Keychain on iOS, Keystore-backed storage on Android).
 * SecureStore keys may only contain letters, digits, `.`, `-` and `_`; the core's names can hold other characters
 * (`agent/<id>`, `claim:<id>`), so every byte outside letters, digits, `.` and `-` (including `_` itself) is written
 * as `_xHH`: reversible, and two different names never map to the same key.
 */
import type { KeyVault } from '@ajwf/client-core';

export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

const PREFIX = 'ajwf.';

export function vaultKey(name: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(name)) {
    const ch = String.fromCharCode(byte);
    const plain = /[A-Za-z0-9.-]/.test(ch);
    out += plain ? ch : `_x${byte.toString(16).padStart(2, '0')}`;
  }
  return PREFIX + out;
}

export function secureStoreVault(store: SecureStoreLike): KeyVault {
  return {
    get: (name) => store.getItemAsync(vaultKey(name)),
    set: (name, value) => store.setItemAsync(vaultKey(name), value),
    delete: (name) => store.deleteItemAsync(vaultKey(name)),
  };
}
