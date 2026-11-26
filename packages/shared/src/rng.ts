/** Seeded PRNG (mulberry32). Deterministic: the same seed always yields the same sequence. */
export type Rng = {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  range(min: number, max: number): number;
  shuffle<T>(list: T[]): T[];
  state(): number;
};

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)]!,
    chance: (p) => next() < p,
    range: (min, max) => min + next() * (max - min),
    shuffle: (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return list;
    },
    state: () => s,
  };
}

/** Small non-cryptographic 53-bit string hash (cyrb53), returned as 14 hex chars. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
