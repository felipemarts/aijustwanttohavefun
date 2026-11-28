import { describe, expect, it } from 'vitest';
import { secureStoreVault, vaultKey, type SecureStoreLike } from './vault';

function fakeSecureStore() {
  const map = new Map<string, string>();
  const valid = /^[A-Za-z0-9._-]+$/;
  const check = (k: string) => {
    // expo-secure-store rejects any other character
    if (!valid.test(k)) throw new Error(`invalid key ${k}`);
  };
  const store: SecureStoreLike = {
    async getItemAsync(k) {
      check(k);
      return map.get(k) ?? null;
    },
    async setItemAsync(k, v) {
      check(k);
      map.set(k, v);
    },
    async deleteItemAsync(k) {
      check(k);
      map.delete(k);
    },
  };
  return { store, map };
}

describe('secureStoreVault', () => {
  it('stores, reads and deletes secrets under names SecureStore would refuse', async () => {
    const { store, map } = fakeSecureStore();
    const vault = secureStoreVault(store);
    await vault.set('agent/c1:key', 'ajwf_sk_123');
    await vault.set('claim link é', 'https://game.example/claim/x');
    expect(await vault.get('agent/c1:key')).toBe('ajwf_sk_123');
    expect(await vault.get('claim link é')).toBe('https://game.example/claim/x');
    await vault.delete('agent/c1:key');
    expect(await vault.get('agent/c1:key')).toBeNull();
    expect([...map.keys()].every((k) => /^[A-Za-z0-9._-]+$/.test(k))).toBe(true);
  });

  it('never maps two names to the same key', () => {
    const names = ['a_b', 'a/b', 'a_x2fb', 'a.b', 'a-b', 'A_B', 'ab', 'a b', '_x', 'é', 'Ã©'];
    expect(new Set(names.map(vaultKey)).size).toBe(names.length);
  });
});
