import { describe, expect, it } from 'vitest';
import { pvpViolation } from '../src/core/pvp.ts';
import { Kit } from '../src/playkit/kit.ts';
import { fromPlain, obj } from '../src/playkit/jv.ts';
import type { Decision } from '../src/playkit/types.ts';

const kit = new Kit();
const obs = fromPlain({
  you: { lvl: 5 },
  room: { id: 'swamp.edge', flags: ['lawless'], agents: [{ name: 'Mallory' }, { name: 'Bram', fallen: true }], monsters: [{ id: 'bog_rat', lvl: 6 }, { id: 'swamp_troll', lvl: 15 }] },
});
const me = fromPlain({ skills: [{ id: 'smite', target: 'enemy' }, { id: 'heal', target: 'ally' }, { id: 'revive', target: 'ally', locked: true }] });
const d = (action: string, params: Record<string, unknown>): Decision => ({ thought: '', action, params: fromPlain(params), note: '' });

describe('the core\'s PvP check before sending (allowPvp false)', () => {
  it('refuses PvP actions and attacks or taunts on anything but a fair monster', () => {
    expect(pvpViolation(kit, d('steal', { target: 'Mallory' }), obs, me, 'Pip')).toMatch(/PvP action/);
    expect(pvpViolation(kit, d('duel_invite', { agent: 'Mallory' }), obs, me, 'Pip')).toMatch(/PvP action/);
    expect(pvpViolation(kit, d('attack', { target: 'Mallory' }), obs, me, 'Pip')).toMatch(/not a monster/);
    expect(pvpViolation(kit, d('taunt', { target: 'Mallory' }), obs, me, 'Pip')).toMatch(/not a monster/);
    // A monster far above the level gap is not on the menu either.
    expect(pvpViolation(kit, d('attack', { target: 'swamp_troll' }), obs, me, 'Pip')).toMatch(/not a monster/);
    expect(pvpViolation(kit, d('attack', { target: 'bog_rat' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, d('move', { dir: 'north' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, { thought: '', action: 'attack', params: obj(), note: '' }, obs, me, 'Pip')).toBeNull();
  });

  it('lets cast reach an agent only with an unlocked supportive skill', () => {
    expect(pvpViolation(kit, d('cast', { skill: 'smite', target: 'bog_rat' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, d('cast', { skill: 'smite', target: 'Mallory' }), obs, me, 'Pip')).toMatch(/not supportive/);
    expect(pvpViolation(kit, d('cast', { skill: 'heal', target: 'Mallory' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, d('cast', { skill: 'heal', target: 'Bram' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, d('cast', { skill: 'heal', target: 'Pip' }), obs, me, 'Pip')).toBeNull();
    expect(pvpViolation(kit, d('cast', { skill: 'revive', target: 'Bram' }), obs, me, 'Pip')).toMatch(/not supportive/);
    expect(pvpViolation(kit, d('cast', { skill: 'heal', target: 'Stranger' }), obs, me, 'Pip')).toMatch(/not supportive/);
    // Without /me, nothing counts as supportive.
    expect(pvpViolation(kit, d('cast', { skill: 'heal', target: 'Mallory' }), obs, null, 'Pip')).toMatch(/not supportive/);
  });
});
