import { createHash } from 'node:crypto';
import { ensureUnique, randomAppearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import { fantasyName } from '@ajwf/bots';
import { createWorld, nameAvailable, registerAgent, type AgentState, type WorldState } from '@ajwf/engine';
import { API_KEY_PREFIX, createRng, type Rng } from '@ajwf/shared';
import { Brain } from './brain';

/** Daytime on the game clock, like the server's tests, so night-only spawns do not vary between runs. */
export const T0 = Date.UTC(2026, 0, 1, 12, 30);

/** A deterministic API key per agent index (valid format), so a seeded database needs no key file. */
export function benchKey(i: number): string {
  return API_KEY_PREFIX + createHash('sha256').update(`ajwf-bench-${i}`).digest('base64url').slice(0, 43);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A free agent name: a fantasy name, with a letter suffix once the plain names run short. */
export function freeName(s: WorldState, rng: Rng): string {
  for (let i = 0; ; i++) {
    let name = fantasyName(rng);
    if (i > 20) name = `${name.slice(0, 14)}${String.fromCharCode(97 + rng.int(0, 25))}${String.fromCharCode(97 + rng.int(0, 25))}`;
    if (nameAvailable(s, name).ok) return name;
  }
}

export type BenchWorld = { s: WorldState; agents: AgentState[]; brains: Brain[]; rng: Rng };

/** A fresh world with `n` claimed bot agents of mixed classes, languages and roles. */
export function populate(content: Content, n: number, seed: number, now = T0): BenchWorld {
  const s = createWorld(content, now);
  const rng = createRng(seed);
  const agents: AgentState[] = [];
  const brains: Brain[] = [];
  for (let i = 0; i < n; i++) {
    const name = freeName(s, rng);
    const brain = Brain.make(name, createRng(rng.int(0, 2 ** 31)));
    const look = ensureUnique(randomAppearance(rng), (h) => s.lookHashes.has(h), rng).appearance;
    const res = registerAgent(s, { name, cls: brain.cls, lang: brain.lang, appearance: look, bot: true, claimed: true }, { now, rng });
    if (!res.ok) throw new Error(`could not register ${name}: ${res.error.code}`);
    agents.push(res.agent);
    brains.push(brain);
  }
  s.dirty.clear();
  return { s, agents, brains, rng };
}
