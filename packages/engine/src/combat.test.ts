import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { derive } from './agent';
import { BALANCE, levelGapXpMod } from './balance';
import { rollDamage } from './combat';
import { newRun } from './run';
import { errCode, errKey, keys, makeKit, MIN, narr, scriptedRng, SEC, type Kit } from './testkit';
import type { AgentState, MonsterInst } from './types';

function mon(k: Kit, room: string, kind: string): MonsterInst {
  const m = k.monsters(room).find((x) => x.kind === kind);
  if (!m) throw new Error(`no ${kind} in ${room}`);
  return m;
}

/** Attacks until the monster dies, returns the result of the killing blow. */
function killIt(k: Kit, a: AgentState, m: MonsterInst) {
  for (let i = 0; i < 100; i++) {
    const r = k.ok(a, 'attack', { target: m.uid });
    if (m.hp <= 0) return r;
    a.hp = k.maxHp(a); // keep the tester alive
  }
  throw new Error('monster never died');
}

describe('damage formula', () => {
  it('stays within max(1, atk * mult * [0.85, 1.15] - def / 2) and crits multiply', () => {
    const k = makeKit();
    const run = newRun(k.s, k.now, createRng(7));
    const C = BALANCE.combat;
    for (const [atk, mult, def] of [
      [12, 1, 2],
      [20, 1.8, 10],
      [5, 1, 40],
    ] as const) {
      const lo = Math.max(1, Math.round(atk * mult * C.randMin - def * C.defFactor));
      const hi = Math.max(1, Math.round(atk * mult * C.randMax - def * C.defFactor));
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 2000; i++) {
        const { dmg, crit } = rollDamage(run, atk, mult, def, 0);
        expect(crit).toBe(false);
        min = Math.min(min, dmg);
        max = Math.max(max, dmg);
      }
      expect(min).toBeGreaterThanOrEqual(lo);
      expect(max).toBeLessThanOrEqual(hi);
      expect(max - min).toBeGreaterThanOrEqual(Math.min(1, hi - lo));
    }
    // Forced crit with the lowest roll.
    const critRun = newRun(k.s, k.now, scriptedRng([0]));
    const r = rollDamage(critRun, 12, 1, 2, 0.05);
    expect(r).toEqual({ dmg: Math.round(12 * C.randMin * C.critMult - 1), crit: true });
  });

  it('crit chance grows with AGI and is capped', () => {
    const k = makeKit();
    const rogue = k.add('Rogo', 'rogue');
    const d = derive(k.c, rogue, k.now);
    expect(d.crit).toBeCloseTo(BALANCE.combat.critBase + d.agi * BALANCE.combat.critPerAgi);
    rogue.level = 20;
    expect(derive(k.c, rogue, k.now).crit).toBeLessThanOrEqual(BALANCE.combat.critMax);
  });
});

describe('attack', () => {
  it('hits, gets hit back, spends 1 AP and engages', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    const m = mon(k, 'forest.edge', 'slime');
    const hp0 = a.hp;
    const r = k.ok(a, 'attack', { target: 'slime' });
    const hit = narr(r, 'n.hit') ?? narr(r, 'n.hit_crit');
    expect(hit).toBeDefined();
    expect(m.hp).toBe(30 - Number(hit!.dmg));
    expect(m.threat[a.id]).toBe(hit!.dmg);
    const back = narr(r, 'n.monster_hits')!;
    expect(a.hp).toBe(hp0 - Number(back.dmg));
    expect(a.ap).toBe(BALANCE.ap.max - 1);
    expect(a.combat).toEqual({ mon: m.uid, until: k.now + BALANCE.combat.engageMs });
    expect(r.events.map((e) => e.type)).toContain('attack');
  });

  it('crits with a lucky roll', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    k.rng = scriptedRng([0]);
    const r = k.ok(a, 'attack', { target: 'slime' });
    expect(keys(r)).toContain('n.hit_crit');
  });

  it('finds the target by kind, by uid or by @mon: reference, and fails on missing ones', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.path' });
    const wolf = mon(k, 'forest.path', 'wolf');
    k.ok(a, 'attack', { target: wolf.uid });
    expect(wolf.threat[a.id]).toBeGreaterThan(0);
    // By kind: prefers the wolf it is already fighting.
    k.ok(a, 'attack', { target: 'Wolf' });
    k.ok(a, 'attack', { target: '@mon:wolf' });
    expect(k.monsters('forest.path').filter((m) => m.kind === 'wolf' && m.threat[a.id]).length).toBe(1);
    const r = k.act(a, 'attack', { target: 'dragon' });
    expect(errCode(r)).toBe('TARGET_NOT_FOUND');
    expect(errKey(r)).toBe('err.monster_not_here');
    const b = k.add('Stranger', 'warrior');
    expect(k.err(b, 'attack', { target: 'slime' })).toBe('TARGET_NOT_FOUND');
  });

  it('kills: XP, gold, loot roll, respawn timer, stats and first blood', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    const m = mon(k, 'forest.edge', 'slime');
    const gold0 = a.gold;
    const r = killIt(k, a, m);
    const kill = narr(r, 'n.kill')!;
    expect(kill.xp).toBe(12);
    expect(a.xp).toBe(12);
    expect(Number(kill.gold)).toBeGreaterThanOrEqual(1);
    expect(Number(kill.gold)).toBeLessThanOrEqual(3);
    expect(a.gold).toBe(gold0 + Number(kill.gold));
    expect(k.monsters('forest.edge').includes(m)).toBe(false);
    expect(a.combat).toBeNull();
    expect(a.stats.kills).toBe(1);
    expect(a.achievements.first_blood).toBe(k.now);
    expect(keys(r)).toContain('n.achievement');
    const ev = r.events.find((e) => e.type === 'kill')!;
    expect(ev.payload.gold).toEqual({ [a.id]: kill.gold });
    expect(k.s.timers.toJSON()).toContainEqual({ at: k.now + 60 * SEC, kind: 'respawn', room: 'forest.edge', slot: m.slot });
    // No retaliation from a dead monster.
    expect(keys(r)).not.toContain('n.monster_hits');
  });

  it('splits XP, gold and loot between two attackers by damage dealt', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const k = makeKit(seed);
      const w = k.add('Warri', 'warrior', { room: 'forest.path' });
      const g = k.add('Magus', 'mage', { room: 'forest.path' });
      const m = mon(k, 'forest.path', 'wolf');
      const gold0 = { w: w.gold, g: g.gold };
      let last;
      for (let i = 0; i < 40 && m.hp > 0; i++) {
        const who = i % 3 === 2 ? g : w; // the warrior does most of the work
        last = k.ok(who, 'attack', { target: m.uid });
        w.hp = k.maxHp(w);
        g.hp = k.maxHp(g);
      }
      expect(m.hp).toBe(0);
      const total = m.threat[w.id]! + m.threat[g.id]!;
      expect(total).toBe(55);
      const mod = levelGapXpMod(1, 2);
      expect(w.xp).toBe(Math.max(1, Math.round(20 * mod * (m.threat[w.id]! / total))));
      expect(g.xp).toBe(Math.max(1, Math.round(20 * mod * (m.threat[g.id]! / total))));
      const ev = last!.events.find((e) => e.type === 'kill')!;
      const parts = ev.payload.gold as Record<string, number>;
      const gold = parts[w.id]! + parts[g.id]!;
      expect(gold).toBeGreaterThanOrEqual(2);
      expect(gold).toBeLessThanOrEqual(5);
      expect(Math.abs(parts[w.id]! - (gold * m.threat[w.id]!) / total)).toBeLessThanOrEqual(1);
      expect(w.gold - gold0.w).toBe(parts[w.id]);
      expect(g.gold - gold0.g).toBe(parts[g.id]);
      // The one who did not land the last blow hears about its share.
      const other = last!.events.find((e) => e.type === 'kill_share');
      expect(other).toBeDefined();
      expect(w.stats.kills).toBe(1);
      expect(g.stats.kills).toBe(1);
    }
  });

  it('a monster nobody hits for a while forgets its attackers and heals', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.path' });
    const m = mon(k, 'forest.path', 'wolf');
    k.ok(a, 'attack', { target: m.uid });
    expect(m.hp).toBeLessThan(55);
    k.advance(BALANCE.combat.monsterResetMs - 10 * SEC);
    k.ok(a, 'attack', { target: m.uid });
    const hp = m.hp;
    expect(hp).toBeLessThan(55);
    k.advance(BALANCE.combat.monsterResetMs + SEC);
    const r = k.ok(a, 'attack', { target: m.uid });
    expect(m.hp).toBe(55 - Number((narr(r, 'n.hit') ?? narr(r, 'n.hit_crit'))!.dmg));
    expect(Object.keys(m.threat)).toEqual([a.id]);
  });
});

describe('death', () => {
  it('falls, waits, wakes at the temple with full HP and 10% less gold', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.gold = 105;
    a.hp = 1;
    const r = k.ok(a, 'attack', { target: 'slime' });
    expect(keys(r)).toContain('n.you_fall');
    expect(a.fallen).not.toBeNull();
    expect(a.hp).toBe(0);
    expect(a.stats.deaths).toBe(1);
    expect(r.events.find((e) => e.type === 'fallen')).toBeDefined();
    expect(k.err(a, 'attack', { target: 'slime' })).toBe('DEAD');
    expect(k.err(a, 'flee')).toBe('DEAD');
    // Still in the room, gold untouched, while waiting for a Cleric.
    k.advance(BALANCE.death.fallenMs - 10 * SEC);
    expect(a.room).toBe('forest.edge');
    expect(a.gold).toBe(105);
    const evs = k.advance(20 * SEC);
    expect(a.fallen).toBeNull();
    expect(a.room).toBe(BALANCE.templeRoom);
    expect(a.gold).toBe(95);
    expect(a.hp).toBe(k.maxHp(a));
    expect(evs.find((e) => e.type === 'respawn')!.payload).toMatchObject({ lost: 10, from: 'forest.edge' });
    expect(k.s.roomAgents.get('forest.edge')!.has(a.id)).toBe(false);
  });

  it('release wakes at the temple right away; it needs to be fallen', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    expect(errKey(k.act(a, 'release'))).toBe('err.not_fallen_self');
    a.gold = 50;
    a.hp = 1;
    k.ok(a, 'attack', { target: 'slime' });
    const r = k.ok(a, 'release');
    expect(keys(r)).toContain('n.wake_temple');
    expect(a.room).toBe(BALANCE.templeRoom);
    expect(a.gold).toBe(45);
    // The pending timer is harmless.
    k.advance(BALANCE.death.fallenMs);
    expect(a.gold).toBe(45);
  });

  it('a Cleric revives in place without losing gold', () => {
    const k = makeKit();
    const v = k.add('Victim', 'warrior', { room: 'forest.edge' });
    const c = k.add('Healer', 'cleric', { room: 'forest.edge', level: 5 });
    v.gold = 100;
    v.hp = 1;
    k.ok(v, 'attack', { target: 'slime' });
    expect(v.fallen).not.toBeNull();
    const mp0 = c.mp;
    const r = k.ok(c, 'revive', { target: 'victim' });
    expect(keys(r)).toContain('n.revive');
    expect(v.fallen).toBeNull();
    expect(v.room).toBe('forest.edge');
    expect(v.gold).toBe(100);
    expect(v.hp).toBe(Math.floor(k.maxHp(v) * BALANCE.death.reviveHp));
    expect(c.mp).toBe(mp0 - 20);
    expect(c.stats.revives).toBe(1);
    k.advance(BALANCE.death.fallenMs);
    expect(v.room).toBe('forest.edge');
    expect(v.gold).toBe(100);
  });

  it('revive errors: class, level, not fallen, missing target, MP', () => {
    const k = makeKit();
    const v = k.add('Victim', 'warrior', { room: 'forest.edge' });
    const w = k.add('Warri', 'warrior', { room: 'forest.edge', level: 5 });
    const low = k.add('Novice', 'cleric', { room: 'forest.edge' });
    const c = k.add('Healer', 'cleric', { room: 'forest.edge', level: 5 });
    expect(k.err(c, 'revive', { target: 'Victim' })).toBe('NOT_ALLOWED');
    v.hp = 1;
    k.ok(v, 'attack', { target: 'slime' });
    expect(k.err(w, 'revive', { target: 'Victim' })).toBe('CLASS_REQUIRED');
    expect(k.err(low, 'revive', { target: 'Victim' })).toBe('LEVEL_REQUIRED');
    expect(k.err(c, 'revive', {})).toBe('INVALID_PARAMS');
    expect(k.err(c, 'cast', { skill: 'revive' })).toBe('INVALID_PARAMS');
    expect(k.err(c, 'revive', { target: 'Someone' })).toBe('TARGET_NOT_FOUND');
    c.mp = 5;
    expect(k.err(c, 'revive', { target: 'Victim' })).toBe('NOT_ENOUGH_MP');
    c.mp = 100;
    k.ok(c, 'cast', { skill: 'revive', target: 'Victim' });
    expect(v.fallen).toBeNull();
  });
});

describe('skills', () => {
  it('damage skills cost MP and hit harder', () => {
    const k = makeKit();
    const g = k.add('Magus', 'mage', { room: 'forest.old_oak' });
    const mp0 = g.mp;
    const r = k.ok(g, 'cast', { skill: 'firebolt', target: 'boar' });
    expect(keys(r)[0]).toBe('n.cast');
    expect(g.mp).toBe(mp0 - 6);
    const dmg = Number((narr(r, 'n.hit') ?? narr(r, 'n.hit_crit'))!.dmg);
    const atk = derive(k.c, g, k.now).atk;
    expect(dmg).toBeGreaterThanOrEqual(Math.round(atk * 1.8 * 0.85 - 2.5));
    expect(keys(r)).toContain('n.monster_hits');
  });

  it('cast errors: unknown, other class, level, MP, cooldown, ambiguous and missing target', () => {
    const k = makeKit();
    const g = k.add('Magus', 'mage', { room: 'forest.edge' });
    expect(k.err(g, 'cast', { skill: 'fireball' })).toBe('TARGET_NOT_FOUND');
    expect(k.err(g, 'cast', { skill: 'heal' })).toBe('CLASS_REQUIRED');
    expect(k.err(g, 'cast', { skill: 'frost_nova' })).toBe('LEVEL_REQUIRED');
    const r = k.act(g, 'cast', { skill: 'firebolt' });
    expect(errCode(r)).toBe('INVALID_PARAMS');
    expect(errKey(r)).toBe('err.need_target');
    expect(k.err(g, 'cast', { skill: 'firebolt', target: 'wolf' })).toBe('TARGET_NOT_FOUND');
    g.mp = 3;
    expect(k.err(g, 'cast', { skill: 'firebolt', target: 'slime' })).toBe('NOT_ENOUGH_MP');
    const w = k.add('Tank', 'warrior', { level: 10 });
    k.ok(w, 'cast', { skill: 'shield_wall' });
    expect(derive(k.c, w, k.now).def).toBe(derive(k.c, { ...w, buffs: [] }, k.now).def + 10);
    const cd = k.act(w, 'cast', { skill: 'shield_wall' });
    expect(errCode(cd)).toBe('COOLDOWN');
    k.advance(61 * SEC);
    k.ok(w, 'cast', { skill: 'shield_wall' });
  });

  it('with a single monster around, the target can be left out', () => {
    const k = makeKit();
    const g = k.add('Magus', 'mage', { room: 'forest.creek' });
    k.monsters('forest.creek').splice(1);
    k.ok(g, 'cast', { skill: 'firebolt' });
    expect(k.monsters('forest.creek')[0]!.threat[g.id]).toBeGreaterThan(0);
  });

  it('taunt makes the monster hit the warrior instead of the attacker', () => {
    const k = makeKit();
    const w = k.add('Tank', 'warrior', { room: 'forest.path', level: 5 });
    const g = k.add('Magus', 'mage', { room: 'forest.path' });
    const m = mon(k, 'forest.path', 'wolf');
    const r0 = k.ok(w, 'taunt', { target: m.uid });
    expect(keys(r0)).toContain('n.taunt');
    expect(m.taunt?.by).toBe(w.id);
    expect(w.combat?.mon).toBe(m.uid);
    expect(w.stats.taunts).toBe(1);
    const gHp = g.hp;
    const wHp = w.hp;
    const r = k.ok(g, 'attack', { target: m.uid });
    const other = narr(r, 'n.monster_hits_other')!;
    expect(other.name).toBe('Tank');
    expect(g.hp).toBe(gHp);
    expect(w.hp).toBe(wHp - Number(other.dmg));
    const hit = r.events.find((e) => e.type === 'hit')!;
    expect(hit.actor).toBe(w.id);
    expect(k.s.inboxes.get(w.id)!.buf).toContain(hit);
    // When the taunt runs out the attacker takes the blows again.
    k.advance(46 * SEC);
    const r2 = k.ok(g, 'attack', { target: m.uid });
    expect(keys(r2)).toContain('n.monster_hits');
  });

  it('taunt errors: class and level', () => {
    const k = makeKit();
    const g = k.add('Magus', 'mage', { room: 'forest.path' });
    const w = k.add('Tank', 'warrior', { room: 'forest.path' });
    expect(k.err(g, 'taunt', { target: 'wolf' })).toBe('CLASS_REQUIRED');
    expect(k.err(w, 'taunt', { target: 'wolf' })).toBe('LEVEL_REQUIRED');
  });

  it('area spells see monsters that reset since their last fight', () => {
    const k = makeKit();
    const w = k.add('Tank', 'warrior', { room: 'forest.path' });
    const g = k.add('Magus', 'mage', { room: 'forest.path', level: 5 });
    const m = mon(k, 'forest.path', 'wolf');
    k.ok(w, 'attack', { target: m.uid });
    k.advance(BALANCE.combat.monsterResetMs + SEC);
    const r = k.ok(g, 'cast', { skill: 'frost_nova' });
    const hit = r.result.ok && r.result.narration.find((x) => (x.k === 'n.hit' || x.k === 'n.hit_crit') && m.threat[g.id] === x.p!.dmg);
    expect(hit).toBeTruthy();
    // The warrior's old damage was forgotten before the blast landed.
    expect(m.threat[w.id]).toBeUndefined();
    expect(m.hp).toBe(55 - m.threat[g.id]!);
  });

  it('area spells hit every monster in the room; only one answers', () => {
    const k = makeKit();
    const g = k.add('Magus', 'mage', { room: 'forest.path', level: 5 });
    const before = k.monsters('forest.path').map((m) => ({ m, hp: m.hp }));
    expect(before.length).toBe(4);
    const r = k.ok(g, 'cast', { skill: 'frost_nova' });
    for (const { m, hp } of before) {
      expect(m.threat[g.id]).toBeGreaterThan(0);
      expect(m.hp).toBeLessThan(hp);
    }
    expect(keys(r).filter((x) => x === 'n.monster_hits').length).toBe(1);
    expect(g.mp).toBe(derive(k.c, g, k.now).maxMp - 14);
    const empty = k.add('Lonely', 'mage', { room: 'village.square', level: 5 });
    expect(errKey(k.act(empty, 'cast', { skill: 'frost_nova' }))).toBe('err.no_monsters_here');
  });

  it('heals self and others, not the fallen nor the healthy', () => {
    const k = makeKit();
    const c = k.add('Healer', 'cleric', { room: 'village.square' });
    const w = k.add('Warri', 'warrior', { room: 'village.square' });
    expect(errKey(k.act(c, 'cast', { skill: 'heal' }))).toBe('err.full_health');
    c.hp = 10;
    const r = k.ok(c, 'cast', { skill: 'heal' });
    expect(Number(narr(r, 'n.heal_self')!.hp)).toBeGreaterThan(0);
    expect(c.hp).toBeGreaterThan(10);
    w.hp = 10;
    const r2 = k.ok(c, 'cast', { skill: 'heal', target: 'Warri' });
    expect(w.hp).toBeCloseTo(10 + Number(narr(r2, 'n.heal_other')!.hp), 0); // plus a second of regeneration
    expect(c.stats.heals).toBe(1);
    w.hp = 0;
    w.fallen = { at: k.now, until: k.now + MIN };
    expect(errKey(k.act(c, 'cast', { skill: 'heal', target: 'Warri' }))).toBe('err.target_fallen');
    expect(k.err(c, 'cast', { skill: 'heal', target: 'Ghost' })).toBe('TARGET_NOT_FOUND');
  });

  it('buffs raise a stat for a while; escape leaves the fight', () => {
    const k = makeKit();
    const r = k.add('Rogo', 'rogue', { room: 'forest.edge', level: 10 });
    const atk = derive(k.c, r, k.now).atk;
    k.ok(r, 'cast', { skill: 'poison_blade' });
    expect(derive(k.c, r, k.now).atk).toBe(atk + 5);
    k.advance(11 * MIN);
    k.refresh(r);
    expect(derive(k.c, r, k.now).atk).toBe(atk);
    expect(r.buffs).toEqual([]);

    expect(errKey(k.act(r, 'cast', { skill: 'vanish' }))).toBe('err.not_in_combat');
    k.ok(r, 'attack', { target: 'slime' });
    k.ok(r, 'cast', { skill: 'vanish' });
    expect(r.combat).toBeNull();
    expect(k.monsters('forest.edge').every((m) => m.threat[r.id] === undefined)).toBe(true);
    k.ok(r, 'move', { dir: 'east' });
  });
});

describe('flee', () => {
  it('needs a fight; succeeds or takes a blow', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    expect(errKey(k.act(a, 'flee'))).toBe('err.not_in_combat');
    k.ok(a, 'attack', { target: 'slime' });
    k.rng = scriptedRng([0.99]);
    const hp = a.hp;
    const fail = k.ok(a, 'flee');
    expect(keys(fail)).toContain('n.flee_fail');
    expect(a.hp).toBeLessThan(hp);
    expect(a.combat).not.toBeNull();
    k.rng = scriptedRng([0.01]);
    const ok = k.ok(a, 'flee');
    expect(keys(ok)).toEqual(['n.flee_ok']);
    expect(a.combat).toBeNull();
    k.ok(a, 'move', { dir: 'east' });
  });
});

describe('combat bookkeeping', () => {
  it('a monster killed by someone else frees its other opponents at once', () => {
    const k = makeKit();
    const w = k.add('Tank', 'warrior', { room: 'forest.path', level: 5 });
    const g = k.add('Magus', 'mage', { room: 'forest.path', level: 5 });
    const m = mon(k, 'forest.path', 'wolf');
    k.ok(w, 'taunt', { target: m.uid });
    killIt(k, g, m);
    // The warrior never dealt damage, so it got no share, but it is not stuck "in combat" either.
    expect(k.err(w, 'flee')).toBe('NOT_ALLOWED');
    k.ok(w, 'move', { dir: 'east' });
  });
});
