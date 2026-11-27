import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { observe } from './observe';
import { errCode, errKey, errKeys, HOUR, makeKit, MIN, narr, SEC } from './testkit';

describe('gather', () => {
  it('takes one unit, spends 2 AP and gives a little XP', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    const max = k.c.rooms.get('forest.edge')!.resources.find((x) => x.id === 'wood')!.max;
    const r = k.ok(a, 'gather', { resource: 'wood' });
    expect(narr(r, 'n.gather')).toEqual({ item: '@item:wood', left: max - 1, xp: BALANCE.xp.gatherBase + 1 });
    expect(a.inv.wood).toBe(1);
    expect(a.ap).toBe(BALANCE.ap.max - 2);
    expect(a.xp).toBe(3);
    expect(a.stats.gathers).toBe(1);
    expect(k.s.rooms.get('forest.edge')!.resources.wood!.qty).toBe(max - 1);
  });

  it('runs out, then regrows over time up to the maximum', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    k.step = 0;
    for (let i = 0; i < 6; i++) k.ok(a, 'gather', { resource: 'green_herb' });
    const r = k.act(a, 'gather', { resource: 'green_herb' });
    expect(errCode(r)).toBe('NOT_AVAILABLE_HERE');
    expect(errKey(r)).toBe('err.resource_depleted');
    const every = HOUR / k.c.rooms.get('forest.edge')!.resources.find((x) => x.id === 'green_herb')!.regen_per_hour;
    k.advance(every - MIN);
    expect(k.err(a, 'gather', { resource: 'green_herb' })).toBe('NOT_AVAILABLE_HERE');
    k.advance(2 * MIN);
    k.ok(a, 'gather', { resource: 'green_herb' });
    expect(k.err(a, 'gather', { resource: 'green_herb' })).toBe('NOT_AVAILABLE_HERE');
    // The partial interval carried over: the next unit comes one interval after the previous one, not after the gather.
    k.advance(every - MIN);
    k.ok(a, 'gather', { resource: 'green_herb' });
    k.advance(10 * HOUR);
    expect(observe(k.s, a.id, k.ctx()).room.resources!.green_herb).toBe(6);
  });

  it('errors: nothing here, wrong resource, full bag', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'gather', { resource: 'wood' }))).toBe('err.nothing_to_gather');
    k.place(a, 'forest.edge');
    const r = k.act(a, 'gather', { resource: 'iron_ore' });
    expect(errKey(r)).toBe('err.resource_not_here');
    expect(!r.result.ok && r.result.error.msg.p?.here).toBe('wood, green_herb');
    a.inv = { iron_sword: 30 };
    expect(k.err(a, 'gather', { resource: 'wood' })).toBe('INVENTORY_FULL');
    expect(k.s.rooms.get('forest.edge')!.resources.wood!.qty).toBe(k.c.rooms.get('forest.edge')!.resources.find((x) => x.id === 'wood')!.max);
  });

  it('an empty node says when its next unit grows back, never too early', () => {
    const every = HOUR / makeKit().c.rooms.get('forest.edge')!.resources.find((x) => x.id === 'green_herb')!.regen_per_hour;
    // Drains the herbs, waits `after`, and gathers once more.
    const drained = (after: number) => {
      const k = makeKit();
      const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
      k.step = 0;
      for (let i = 0; i < 6; i++) k.ok(a, 'gather', { resource: 'green_herb' });
      k.advance(after);
      return { k, a, r: errKeys(k.act(a, 'gather', { resource: 'green_herb' }))! };
    };
    // Long waits in minutes, short ones in seconds.
    for (const after of [0, every - 90 * SEC, every - 1500]) {
      const { r } = drained(after);
      expect(r).toMatchObject({ msg: 'err.resource_depleted', hint: 'hint.resource_depleted' });
      const seconds = Math.ceil((every - after) / SEC);
      expect(r.p).toEqual({ item: '@item:green_herb', seconds, minutes: seconds >= BALANCE.waitHint.minutesFromSec ? Math.ceil(seconds / 60) : 0 });
      expect((r.p!.minutes as number) > 0).toBe(after === 0);
    }
    // One second before the wait told is too early; once it is over, the gather works.
    const { k, a, r } = drained(every - 1500);
    k.advance((r.p!.seconds as number) * SEC - SEC);
    expect(k.err(a, 'gather', { resource: 'green_herb' })).toBe('NOT_AVAILABLE_HERE');
    k.advance(SEC);
    k.ok(a, 'gather', { resource: 'green_herb' });
  });
});

describe('professions and crafting', () => {
  it('a profession is chosen once, from level 5', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(k.err(a, 'choose_profession', { profession: 'blacksmith' })).toBe('LEVEL_REQUIRED');
    expect(k.err(a, 'choose_profession', { profession: 'wizard' })).toBe('INVALID_PARAMS');
    k.setLevel(a, 5);
    const r = k.ok(a, 'choose_profession', { profession: 'blacksmith' });
    expect(narr(r, 'n.profession_chosen')).toEqual({ prof: '@prof:blacksmith' });
    expect(a.profession).toBe('blacksmith');
    expect(errKey(k.act(a, 'choose_profession', { profession: 'cook' }))).toBe('err.profession_taken');
  });

  it('crafts at the right station with the inputs', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 5 });
    k.ok(a, 'choose_profession', { profession: 'blacksmith' });
    a.inv.iron_ore = 5;
    a.inv.coal = 1;
    expect(errKey(k.act(a, 'craft', { recipe: 'smelt_iron' }))).toBe('err.no_station');
    k.place(a, 'village.smithy');
    const r = k.ok(a, 'craft', { recipe: 'smelt_iron' });
    expect(narr(r, 'n.craft')).toEqual({ item: '@item:iron_ingot', qty: 1, xp: BALANCE.xp.craftBase + 5 * BALANCE.xp.craftPerLevel });
    expect(a.inv).toMatchObject({ iron_ore: 3, iron_ingot: 1 });
    expect(a.inv.coal).toBeUndefined();
    expect(a.ap).toBe(BALANCE.ap.max - 2);
    expect(a.achievements.apprentice).toBeDefined();
    const miss = k.act(a, 'craft', { recipe: 'smelt_iron' });
    expect(errCode(miss)).toBe('MISSING_ITEMS');
    expect(!miss.result.ok && miss.result.error.msg.p?.missing).toBe('coal x1');
    expect(a.inv.iron_ore).toBe(3);
  });

  it('craft errors: unknown recipe, profession, level, full bag', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.smithy', level: 5 });
    expect(k.err(a, 'craft', { recipe: 'philosopher_stone' })).toBe('TARGET_NOT_FOUND');
    expect(k.err(a, 'craft', { recipe: 'smelt_iron' })).toBe('PROFESSION_REQUIRED');
    k.ok(a, 'choose_profession', { profession: 'blacksmith' });
    expect(k.err(a, 'craft', { recipe: 'forge_chainmail' })).toBe('LEVEL_REQUIRED');
    // blow_flasks: 1 copper + 1 stone -> 3 flasks; a bag full of swords and the two inputs has no room for a new stack.
    a.inv = { iron_sword: 28, copper_ore: 2, stone: 2 };
    expect(k.err(a, 'craft', { recipe: 'blow_flasks' })).toBe('INVENTORY_FULL');
    a.inv = { iron_sword: 28, copper_ore: 1, stone: 1 };
    k.ok(a, 'craft', { recipe: 'blow_flasks' });
    expect(a.inv.flask).toBe(3);
  });
});
