import { describe, expect, it } from 'vitest';
import { errKeys, makeKit } from './testkit';

/** The params of a refusal (they feed both the message and the hint). */
function params(r: ReturnType<typeof errKeys>): Record<string, string | number> {
  return r?.p ?? {};
}

describe('names typed by agents in refusals', () => {
  it('become references to the monster, item or NPC they name, so they render localized; unknown names stay as typed', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 10, room: 'forest.edge' });
    // A kind that lives here but is respawning, and a known kind that does not live here.
    for (const m of k.monsters('forest.edge')) m.hp = 1;
    for (const m of [...k.monsters('forest.edge')]) k.ok(a, 'attack', { target: m.uid });
    const respawning = errKeys(k.act(a, 'attack', { target: 'Slime' }));
    expect(respawning!.msg).toBe('err.monster_respawning');
    expect(params(respawning).target).toBe('@mon:slime');
    expect(params(errKeys(k.act(a, 'attack', { target: 'wolf' })))).toEqual({ target: '@mon:wolf' });
    expect(params(errKeys(k.act(a, 'attack', { target: 'dragon' })))).toEqual({ target: 'dragon' });

    expect(params(errKeys(k.act(a, 'gather', { resource: 'Iron Ore' })))).toMatchObject({ resource: '@item:iron_ore' });
    expect(params(errKeys(k.act(a, 'gather', { resource: 'mithril' })))).toMatchObject({ resource: 'mithril' });
    expect(params(errKeys(k.act(a, 'take', { item: 'iron-sword' })))).toEqual({ item: '@item:iron_sword' });
    expect(params(errKeys(k.act(a, 'equip', { item: 'iron sword' })))).toEqual({ item: '@item:iron_sword' });
    expect(params(errKeys(k.act(a, 'unequip', { item: 'iron_sword' })))).toEqual({ item: '@item:iron_sword' });
    expect(params(errKeys(k.act(a, 'unequip', { item: 'banana' })))).toEqual({ item: 'banana' });
    expect(params(errKeys(k.act(a, 'talk', { npc: 'Olga' })))).toEqual({ npc: '@npc:olga' });
    expect(params(errKeys(k.act(a, 'talk', { npc: 'npc.olga' })))).toEqual({ npc: '@npc:olga' });
    expect(params(errKeys(k.act(a, 'talk', { npc: 'Gandalf' })))).toEqual({ npc: 'Gandalf' });

    k.place(a, 'village.smithy');
    expect(params(errKeys(k.act(a, 'shop_buy', { npc: 'gunnar', item: 'Wood' })))).toMatchObject({ item: '@item:wood' });
    expect(params(errKeys(k.act(a, 'shop_sell', { npc: 'gunnar', item: 'Wood', qty: 2 })))).toMatchObject({ item: '@item:wood' });
  });
});
