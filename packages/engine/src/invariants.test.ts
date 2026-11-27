import { describe, expect, it } from 'vitest';
import { checkInvariants } from './invariants';
import { makeKit } from './testkit';

describe('checkInvariants', () => {
  it('is empty for a fresh world', () => {
    const k = makeKit();
    k.add('Pip', 'warrior');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('reports each kind of violation', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Wild', 'mage', { claimed: false });
    a.gold = -1;
    a.ap = 999;
    a.hp = 10_000;
    a.inv.wood = 0;
    a.inv.iron_sword = 40;
    b.level = 7;
    b.hp = 0;
    k.s.roomAgents.get('village.square')!.delete(b.id);
    const m = k.monsters('forest.edge')[0]!;
    m.hp = 0;
    k.monsters('forest.edge').push({ ...k.monsters('forest.edge')[1]!, uid: 'mx' });
    k.monsters('forest.path').push({ uid: 'my', kind: 'dragon', hp: 5, slot: -1, threat: {}, taunt: null, lastHit: 0 });
    k.s.rooms.get('forest.edge')!.resources.wood!.qty = 99;
    const v = checkInvariants(k.s, k.now).join('\n');
    for (const bit of ['gold -1', 'AP 999', 'above max', '0 x wood', 'inventory slots', 'unclaimed agent at level 7', 'while standing', 'missing from the index', 'HP 0', 'second living monster', 'unknown kind', 'stock 99']) {
      expect(v).toContain(bit);
    }
  });
});

describe('checkInvariants: trust', () => {
  it('reports broken honor, infamy, Wanted, bounties and coup votes', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    a.honor = 0.5;
    a.infamy = 200;
    b.wanted = { since: k.now, prev: null, until: k.now + 1000 };
    k.s.bounties[b.id] = { target: b.id, total: 50, by: [{ id: a.id, name: 'Pip', gold: 40 }], at: k.now, due: k.now + 1000 };
    k.place(a, 'village.guild_hall');
    a.gold = 1000;
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    k.s.guilds.get(a.guild!)!.coup = [a.id];
    const v = checkInvariants(k.s, k.now).join('\n');
    for (const bit of ['honor 0.5', 'above the line but not wanted', 'wanted without the wanted title', 'without a timer', 'do not add up', 'no refund timer', 'coup vote by']) {
      expect(v).toContain(bit);
    }
  });
});
