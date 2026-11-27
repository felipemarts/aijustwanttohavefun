import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { CLASSES, fuzz, SOCIAL_ACTION } from './fuzzkit';
import { makeKit } from './testkit';
import type { AgentState } from './types';

describe('fuzz: social', () => {
  it('12,000 social and trading actions in the village keep every invariant and conserve gold and items', () => {
    const k = makeKit(4242);
    const rng = createRng(99);
    const rooms = ['village.market', 'village.tavern', 'village.guild_hall', 'village.training_yard', 'village.square', 'forest.edge'];
    const agents: AgentState[] = [];
    for (let i = 0; i < 18; i++) {
      const a = k.add(`Soc${i}`, CLASSES[i % 4]!, { claimed: i % 9 !== 8, room: rooms[i % rooms.length], level: i % 9 === 8 ? 2 : i % 3 === 0 ? 11 : 1 + (i % 5) });
      a.gold = rng.int(600, 1500);
      Object.assign(a.inv, { iron_ore: 6, wood: 5, minor_potion: 3, wolf_pelt: 2, bread: 4 });
      agents.push(a);
    }
    // Social actions dominate: what the room suggests, or any social action at all.
    const f = fuzz(k, rng, agents, 12_000, SOCIAL_ACTION, new Map(agents.map((a) => [a, a.room])));
    console.log('social fuzz ok actions', f.ok);
    console.log('social fuzz errors', f.errors);
    console.log(`social fuzz: transfers checked ${f.transfers}, unchanged-on-error checks ${f.unchanged}, escorts started ${k.s.meta.escortSeq}`);
    for (const action of [
      'friend_request', 'friend_accept', 'declare_rival', 'party_invite', 'party_accept', 'party_leave', 'party_say', 'trade_offer', 'trade_accept',
      'trade_cancel', 'market_sell', 'market_buy', 'market_list', 'duel_invite', 'duel_accept', 'board_post', 'board_read', 'journal', 'guild_create',
      'guild_invite', 'guild_join', 'guild_deposit', 'guild_withdraw', 'guild_say', 'wish',
    ]) {
      expect(f.ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(f.transfers).toBeGreaterThan(100);
    expect(f.unchanged).toBeGreaterThan(500);
  });
});
