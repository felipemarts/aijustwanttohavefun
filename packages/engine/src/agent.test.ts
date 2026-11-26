import { describe, expect, it } from 'vitest';
import { derive, gainXp } from './agent';
import { BALANCE, xpToNext } from './balance';
import { eventsSince } from './observe';
import { newRun } from './run';
import { keys, makeKit, MIN, narr, SEC } from './testkit';

describe('AP', () => {
  it('regenerates lazily, one point per interval, keeping the remainder and capped at max', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.ap = 0;
    a.apAt = k.now;
    k.advance(BALANCE.ap.regenMs * 3 + 30 * SEC);
    k.refresh(a);
    expect(a.ap).toBe(3);
    k.advance(BALANCE.ap.regenMs - 30 * SEC);
    k.refresh(a);
    expect(a.ap).toBe(4);
    k.advance(BALANCE.ap.regenMs * 10_000);
    k.refresh(a);
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('each action costs its AP; social and inventory actions are free', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.ok(a, 'inventory');
    k.ok(a, 'emote', { emote: 'wave' });
    k.ok(a, 'quest_list');
    expect(a.ap).toBe(BALANCE.ap.max);
    k.ok(a, 'move', { dir: 'west' });
    expect(a.ap).toBe(BALANCE.ap.max - 1);
    // Spending from a full bar starts the regeneration clock then, not at the last update.
    k.advance(BALANCE.ap.regenMs);
    k.refresh(a);
    expect(a.ap).toBe(BALANCE.ap.max);
  });
});

describe('HP and MP regeneration', () => {
  it('heals a share of the maximum per minute out of combat', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const max = k.maxHp(a);
    a.hp = max / 2;
    a.mp = 0;
    a.regenAt = k.now;
    k.advance(10 * MIN);
    k.refresh(a);
    expect(a.hp).toBeCloseTo(max / 2 + max * BALANCE.regen.hpPerMin * 10);
    expect(a.mp).toBeCloseTo(derive(k.c, a, k.now).maxMp * BALANCE.regen.mpPerMin * 10);
    k.advance(10 * 60 * MIN);
    k.refresh(a);
    expect(a.hp).toBe(max);
  });

  it('does not heal during a fight, only from the moment it ends', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.path' });
    const max = k.maxHp(a);
    a.hp = 50;
    k.ok(a, 'attack', { target: 'wolf' });
    const hp = a.hp;
    const engagedAt = k.now;
    k.advance(40 * SEC);
    k.refresh(a);
    expect(a.hp).toBe(hp);
    k.advance(10 * MIN);
    k.refresh(a);
    const freeFor = k.now - (engagedAt + BALANCE.combat.engageMs);
    expect(a.hp).toBeCloseTo(hp + (max * BALANCE.regen.hpPerMin * freeFor) / MIN);
  });

  it('nothing regenerates while fallen', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.hp = 0;
    a.fallen = { at: k.now, until: k.now + 100 * MIN };
    k.advance(10 * MIN);
    k.refresh(a);
    expect(a.hp).toBe(0);
  });

  it('a regen buff speeds it up', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const max = k.maxHp(a);
    a.inv.travelers_ration = 1;
    a.hp = 10;
    k.ok(a, 'use', { item: 'travelers_ration' });
    const hp = a.hp;
    k.advance(10 * MIN);
    k.refresh(a);
    expect(a.hp).toBeCloseTo(hp + max * BALANCE.regen.hpPerMin * 1.25 * 10 + (max * BALANCE.regen.hpPerMin * 1.25) / 60, 1);
  });
});

describe('levels', () => {
  it('follows round(100 * level^1.5)', () => {
    expect([1, 2, 3, 4, 5, 10, 19].map(xpToNext)).toEqual([100, 283, 520, 800, 1118, 3162, 8282]);
  });

  it('levels up with a full heal, keeps the leftover XP and can jump several levels', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.hp = 5;
    const run = newRun(k.s, k.now, k.rng, a);
    expect(gainXp(run, a, 2000)).toBe(2000);
    expect(a.level).toBe(5);
    expect(a.xp).toBe(2000 - 100 - 283 - 520 - 800);
    expect(a.hp).toBe(k.maxHp(a));
    expect(a.mp).toBe(derive(k.c, a, k.now).maxMp);
    expect(run.narr.filter((m) => m.k === 'n.level_up').map((m) => m.p!.level)).toEqual([2, 3, 4, 5]);
    expect(run.narr.find((m) => m.k === 'n.skill_learned')!.p!.skill).toBe('@skill:taunt');
    expect(run.narr.map((m) => m.k)).toContain('n.profession_available');
    expect(run.events.filter((e) => e.type === 'level_up').length).toBe(4);
    expect(a.achievements.level_5).toBeDefined();
    expect(a.stats.level).toBe(5);
  });

  it('unlocks each class skill at its level', () => {
    const k = makeKit();
    for (const cls of ['warrior', 'mage', 'rogue', 'cleric'] as const) {
      const a = k.add(`Lvl${cls}`, cls);
      const run = newRun(k.s, k.now, k.rng, a);
      gainXp(run, a, 200_000);
      expect(a.level).toBe(BALANCE.maxLevel);
      expect(a.xp).toBe(0);
      const learned = run.narr.filter((m) => m.k === 'n.skill_learned').map((m) => m.p!.skill);
      const skills = k.c.classes.get(cls)!.skills.filter((s) => k.c.skills.get(s)!.level > 1);
      expect(learned).toEqual(skills.map((s) => `@skill:${s}`));
      expect(gainXp(run, a, 100)).toBe(0);
    }
  });

  it('a kill can level up; the curve is used through real actions', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.xp = 95;
    const m = k.monsters('forest.edge')[0]!;
    let r;
    for (let i = 0; i < 10 && m.hp > 0; i++) r = k.ok(a, 'attack', { target: m.uid });
    expect(a.level).toBe(2);
    expect(a.xp).toBe(95 + 12 - 100);
    expect(keys(r!)).toContain('n.level_up');
  });

  it('unclaimed agents stop at level 3', () => {
    const k = makeKit();
    const a = k.add('Wild', 'warrior', { claimed: false });
    const run = newRun(k.s, k.now, k.rng, a);
    gainXp(run, a, 5000);
    expect(a.level).toBe(BALANCE.unclaimedMaxLevel);
    expect(a.xp).toBe(0);
    expect(run.narr.map((m) => m.k)).toContain('n.unclaimed_cap');
    expect(gainXp(run, a, 100)).toBe(0);
    expect(a.level).toBe(3);
    // Once claimed, it can progress again.
    a.claimed = true;
    gainXp(run, a, 600);
    expect(a.level).toBe(4);
  });

  it('far lower monsters give less XP, higher ones a little more', () => {
    const k = makeKit();
    const a = k.add('Vet', 'warrior', { room: 'forest.edge', level: 8 });
    const m = k.monsters('forest.edge')[0]!;
    let r;
    for (let i = 0; i < 10 && m.hp > 0; i++) r = k.ok(a, 'attack', { target: m.uid });
    // 8 - 1 = 7 levels apart: 1 - 0.2 * (7 - 3) = 0.2.
    expect(narr(r!, 'n.kill')!.xp).toBe(Math.round(12 * 0.2));
  });
});

describe('achievements', () => {
  it('world firsts go to the first agent only', () => {
    const k = makeKit();
    const a = k.add('First', 'warrior');
    const b = k.add('Second', 'warrior');
    gainXp(newRun(k.s, k.now, k.rng, a), a, 20_000);
    const r = newRun(k.s, k.now, k.rng, b);
    gainXp(r, b, 20_000);
    expect(a.level).toBeGreaterThanOrEqual(10);
    expect(b.level).toBe(a.level);
    expect(a.achievements.wf_level_10).toBeDefined();
    expect(b.achievements.wf_level_10).toBeUndefined();
    expect(b.achievements.level_10).toBeDefined();
    expect(k.s.meta.worldFirsts.wf_level_10).toBe(a.id);
    const ev = r.events.filter((e) => e.type === 'achievement').map((e) => e.payload.ach);
    expect(ev).toContain('level_10');
    expect(ev).not.toContain('wf_level_10');
  });

  it('titles come with their achievements', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.stats.deaths = 9;
    a.hp = 1;
    k.place(a, 'forest.edge');
    k.ok(a, 'attack', { target: 'slime' });
    expect(a.achievements.phoenix).toBeDefined();
    expect(a.titles).toContain('phoenix');
    k.ok(a, 'release');
    k.ok(a, 'set_title', { title: 'phoenix' });
    expect(a.title).toBe('phoenix');
    expect(k.err(a, 'set_title', { title: 'mayor' })).toBe('TARGET_NOT_FOUND');
    k.ok(a, 'set_title', { title: null });
    expect(a.title).toBeNull();
  });
});

describe('inbox', () => {
  it('delivers room events to the others present and pages with a cursor', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    const far = k.add('Faraway', 'warrior', { room: 'village.temple' });
    const start = eventsSince(k.s, b.id, 0);
    // The arrival of later agents is in b's inbox already.
    const cursor = start.cursor;
    k.ok(a, 'emote', { emote: 'wave' });
    k.ok(a, 'emote', { emote: 'bow', target: 'Bob' });
    const got = eventsSince(k.s, b.id, cursor);
    expect(got.events.map((e) => e.type)).toEqual(['emote', 'emote']);
    expect(got.events[1]!.target).toBe(b.id);
    expect(got.cursor).toBe(k.s.meta.eventSeq);
    expect(eventsSince(k.s, b.id, got.cursor).events).toEqual([]);
    // The actor does not get its own events; agents elsewhere do not either.
    expect(eventsSince(k.s, a.id, cursor).events).toEqual([]);
    expect(eventsSince(k.s, far.id, cursor).events).toEqual([]);
    // Paging.
    for (let i = 0; i < 5; i++) k.ok(a, 'emote', { emote: 'nod' });
    const p1 = eventsSince(k.s, b.id, got.cursor, 3);
    expect(p1.events.length).toBe(3);
    const p2 = eventsSince(k.s, b.id, p1.cursor, 3);
    expect(p2.events.length).toBe(2);
    expect(Number(p2.events[0]!.id)).toBe(Number(p1.events[2]!.id) + 1);
  });

  it('keeps only the latest events', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    for (let i = 0; i < BALANCE.inbox.size + 10; i++) k.ok(a, 'emote', { emote: 'nod' });
    const all = eventsSince(k.s, b.id, 0, 1000).events;
    expect(all.length).toBe(BALANCE.inbox.size);
    expect(all[all.length - 1]!.id).toBe(String(k.s.meta.eventSeq));
  });
});
