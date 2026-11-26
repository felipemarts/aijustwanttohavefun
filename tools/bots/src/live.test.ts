import { loadContent } from '@ajwf/content/node';
import { applyAction, createWorld, registerAgent, type WorldState } from '@ajwf/engine';
import { randomAppearance } from '@ajwf/appearance';
import { checkAgentName, containsBlockedWord, createRng, isActionName, LANGUAGES, sanitizeAgentText } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { fantasyName, nameGenerator } from './names';
import { RatePacer, TokenBucket, percentile } from './pacing';
import { CHAT_LINES, decidePersonality, EMOTES, newMemory, PERSONALITIES } from './personality';
import { viewFromApi, viewFromWorld } from './view';

const content = loadContent();
const NOW = Date.UTC(2026, 0, 5, 9);

function world(): { s: WorldState; id: string } {
  const s = createWorld(content, NOW);
  const rng = createRng(1);
  const r = registerAgent(s, { name: 'Viewer', cls: 'mage', lang: 'en', appearance: randomAppearance(rng), claimed: true, bot: true }, { now: NOW, rng });
  if (!r.ok) throw new Error(r.error.code);
  // Wear the starting armor, or every policy's first answer is to put it on.
  for (const item of Object.keys(r.agent.inv)) applyAction(s, { agentId: r.agent.id, action: 'equip', params: { item } }, { now: NOW, rng });
  return { s, id: r.agent.id };
}

describe('fantasy names', () => {
  it('are valid, plausible, distinct and seeded', () => {
    const next = nameGenerator(createRng(9));
    const names = Array.from({ length: 300 }, next);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(300);
    for (const n of names) {
      expect(checkAgentName(n).ok, n).toBe(true);
      expect(n).toMatch(/^[A-Z][a-z]+(_[A-Z][a-z]+)?$/);
    }
    expect(fantasyName(createRng(4))).toBe(fantasyName(createRng(4)));
  });
});

describe('chat lines', () => {
  it('exist for every launch language, pass the filters unchanged and fit a say', () => {
    for (const lang of LANGUAGES) {
      expect(CHAT_LINES[lang].length).toBeGreaterThan(3);
      for (const line of CHAT_LINES[lang]) {
        expect(containsBlockedWord(line.toLowerCase()), line).toBe(false);
        expect(sanitizeAgentText(line, 500).text).toBe(line);
      }
    }
    for (const e of EMOTES) expect(content.emotes.has(e), e).toBe(true);
  });
});

describe('views', () => {
  it('the API adapter gives the policy the same view as the engine', () => {
    const { s, id } = world();
    const fromWorld = viewFromWorld(s, id, { now: NOW, rng: createRng(1) });
    const { obs, inv } = fromWorld;
    // What a compact /look and /me would carry.
    const room = { id: obs.room.id, name: 'x', flags: obs.room.flags, exits: obs.room.exits, npcs: obs.room.npcs };
    const you = { lvl: obs.you.lvl, hp: obs.you.hp, mp: obs.you.mp, ap: obs.you.ap, gold: obs.you.gold, xp: [0, 100] as [number, number], bag: [2, 30] as [number, number] };
    const fromApi = viewFromApi(content, you, room, inv);
    expect(fromApi.obs.room.zone).toBe(obs.room.zone);
    expect(fromApi.obs.room.monsters).toEqual([]);
    for (const p of PERSONALITIES) {
      const a = decidePersonality(p, fromApi, { c: content, rng: createRng(5), now: NOW, lang: 'en', mem: newMemory() });
      const b = decidePersonality(p, fromWorld, { c: content, rng: createRng(5), now: NOW, lang: 'en', mem: newMemory() });
      expect(a).toEqual(b);
    }
  });
});

describe('personalities', () => {
  it('always produce a known action with params the schemas accept, or a wait', async () => {
    const { actionParamSchemas } = await import('@ajwf/shared');
    const { s, id } = world();
    const seen = new Set<string>();
    for (const p of PERSONALITIES) {
      const rng = createRng(PERSONALITIES.indexOf(p));
      const mem = newMemory();
      for (let i = 0; i < 200; i++) {
        const view = viewFromWorld(s, id, { now: NOW, rng });
        const step = decidePersonality(p, view, { c: content, rng, now: NOW + i * 5_000, lang: 'ja', mem });
        if ('wait' in step) continue;
        expect(isActionName(step.action)).toBe(true);
        expect(actionParamSchemas[step.action].safeParse(step.params).success, JSON.stringify(step)).toBe(true);
        seen.add(`${p}:${step.action}`);
      }
    }
    // Each temperament shows: the chatterbox talks, the gatherer heads for resources, the wanderer walks.
    expect([...seen].some((x) => x === 'chatterbox:say' || x === 'chatterbox:emote')).toBe(true);
    expect(seen.has('gatherer:move') || seen.has('gatherer:gather')).toBe(true);
    expect(seen.has('wanderer:move')).toBe(true);
  });

  it('a gatherer gathers where resources are left', () => {
    const { s, id } = world();
    const room = [...content.rooms.values()].find((r) => r.resources.length && r.zone !== 'village')!;
    const view = viewFromWorld(s, id, { now: NOW, rng: createRng(1) });
    view.obs.room = { ...view.obs.room, id: room.id, zone: room.zone, resources: { [room.resources[0]!.id]: 3 } };
    const picks = Array.from({ length: 20 }, (_, i) => decidePersonality('gatherer', view, { c: content, rng: createRng(i), now: NOW, lang: 'en', mem: newMemory() }));
    expect(picks.some((p) => 'action' in p && p.action === 'gather' && p.params.resource === room.resources[0]!.id)).toBe(true);
  });
});

describe('pacing', () => {
  it('spaces slots evenly across callers', async () => {
    let t = 0;
    const waits: number[] = [];
    const pacer = new RatePacer(4, async (ms) => void waits.push(ms), () => t);
    for (let i = 0; i < 4; i++) await pacer.take();
    expect(waits).toEqual([0, 250, 500, 750]);
    t = 2_000;
    waits.length = 0;
    await pacer.take();
    expect(waits).toEqual([0]);
  });

  it('a key bucket allows a burst, then refills slower than the server limit', async () => {
    let t = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket(3, 30, async (ms) => {
      slept.push(ms);
      t += ms;
    }, () => t);
    for (let i = 0; i < 3; i++) await bucket.take();
    expect(slept).toEqual([]);
    await bucket.take();
    expect(slept).toEqual([2_000]);
  });

  it('percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});
