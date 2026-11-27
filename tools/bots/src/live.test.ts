import { loadContent } from '@ajwf/content/node';
import { applyAction, createWorld, registerAgent, type WorldState } from '@ajwf/engine';
import { randomAppearance } from '@ajwf/appearance';
import { checkAgentName, containsBlockedWord, createRng, isActionName, LANGUAGES, MAX_WISH_LEN, sanitizeAgentText } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { createClient, type FetchLike } from '@ajwf/sdk';
import { REGISTER_CONCURRENCY, registerBots } from './live-runner';
import { fantasyName, nameGenerator } from './names';
import { RatePacer, Stopper, TokenBucket, percentile } from './pacing';
import { CHAT_LINES, decidePersonality, EMOTES, newMemory, PERSONALITIES, WISH_LINES } from './personality';
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

  it('wishes exist for every launch language, pass the filters unchanged and fit a wish', () => {
    for (const lang of LANGUAGES) {
      expect(WISH_LINES[lang].length).toBeGreaterThan(2);
      for (const line of WISH_LINES[lang]) {
        expect(containsBlockedWord(line.toLowerCase()), line).toBe(false);
        expect(sanitizeAgentText(line, MAX_WISH_LEN).text).toBe(line);
      }
    }
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

  it('at the fountain with gold to spare, a bot now and then makes a short wish in its language, at most once a minute', () => {
    const { s, id } = world();
    s.agents.get(id)!.gold = 100;
    const view = viewFromWorld(s, id, { now: NOW, rng: createRng(1) });
    expect(view.obs.room.flags).toContain('fountain');
    const rng = createRng(3);
    const mem = newMemory();
    const wishes: { at: number; gold: number; text: string }[] = [];
    for (let i = 0; i < 2_000; i++) {
      const step = decidePersonality('fighter', view, { c: content, rng, now: NOW + i * 5_000, lang: 'fr', mem });
      if ('action' in step && step.action === 'wish') wishes.push({ at: NOW + i * 5_000, ...(step.params as { gold: number; text: string }) });
    }
    expect(wishes.length).toBeGreaterThan(5);
    for (const w of wishes) {
      expect(w.gold).toBeGreaterThanOrEqual(1);
      expect(w.gold).toBeLessThanOrEqual(3);
      expect(WISH_LINES.fr).toContain(w.text);
    }
    for (let i = 1; i < wishes.length; i++) expect(wishes[i]!.at - wishes[i - 1]!.at).toBeGreaterThanOrEqual(60_000);
    // Short of gold, or away from the fountain: no wish.
    const poor = { ...view, obs: { ...view.obs, you: { ...view.obs.you, gold: 19 } } };
    const away = { ...view, obs: { ...view.obs, room: { ...view.obs.room, flags: ['safe'] } } };
    for (const v of [poor, away]) {
      const m = newMemory();
      for (let i = 0; i < 500; i++) {
        const step = decidePersonality('fighter', v, { c: content, rng, now: NOW + i * 5_000, lang: 'en', mem: m });
        expect('action' in step && step.action === 'wish').toBe(false);
      }
    }
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

  it('with the admin token, registration is not paced: only the concurrency bounds it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    const fetch: FetchLike = async (url, init) => {
      expect(url).toMatch(/\/agents\/register$/);
      expect((init.headers as Record<string, string>)['x-admin-token']).toBe('admin');
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const body = JSON.parse(String(init.body)) as { name: string };
      return new Response(JSON.stringify({ ok: true, agent: { name: body.name }, api_key: `key${++n}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const base = createClient({ baseUrl: 'http://bots.test', adminToken: 'admin', fetch });
    // More than the paced burst (100): a paced run would wait about a minute here.
    const count = 150;
    const t0 = Date.now();
    const regs = await registerBots(base, count, { admin: true, rng: createRng(4), stopper: new Stopper() });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(regs.map((r) => r.index)).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(maxInFlight).toBe(REGISTER_CONCURRENCY.admin);
    // Seeds, languages and personalities follow the seed and the index, not the order of the answers.
    const again = await registerBots(createClient({ baseUrl: 'http://bots.test', adminToken: 'admin', fetch }), count, { admin: true, rng: createRng(4), stopper: new Stopper() });
    expect(again.map((r) => [r.lang, r.personality])).toEqual(regs.map((r) => [r.lang, r.personality]));
  });

  it('percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});
