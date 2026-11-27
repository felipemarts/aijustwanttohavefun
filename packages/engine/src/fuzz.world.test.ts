import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { ANY_ACTION, CLASSES, fuzz, SOCIAL_ACTION } from './fuzzkit';
import { checkInvariants } from './invariants';
import { HOUR, makeKit } from './testkit';
import type { AgentState } from './types';

describe('fuzz: world', () => {
  it('10,000 plausible and implausible actions by 30 agents in the village and the forest keep every invariant and conserve gold', () => {
    const k = makeKit(2026);
    const rng = createRng(77);
    const rooms = ['village.square', 'village.tavern', 'village.smithy', 'forest.edge', 'forest.path', 'forest.glade', 'forest.old_oak', 'forest.creek', 'hills.trail', 'mines.entrance'];
    const agents: AgentState[] = [];
    for (let i = 0; i < 30; i++) {
      const a = k.add(`Fuzz${i}`, CLASSES[i % 4]!, { claimed: i % 6 !== 5, room: rooms[i % rooms.length], level: i % 6 === 5 ? 1 + (i % 3) : 1 + (i % 7) });
      a.gold = rng.int(0, 300);
      if (i % 5 === 0) Object.assign(a.inv, { iron_ore: 6, coal: 3, copper_ore: 2, stone: 2, minor_potion: 2, red_dye: 1, small_bag: 1, cos_chef_hat: 1 });
      if (i % 9 === 0) a.mutedUntil = k.now + 2 * HOUR;
      // The ones starting at the tavern arrive wounded, so resting gets exercised.
      if (a.room === 'village.tavern') a.hp = 1;
      agents.push(a);
    }
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const f = fuzz(k, rng, agents, 10_000, [...ANY_ACTION, ...SOCIAL_ACTION]);
    const levels = agents.map((a) => a.level);
    const deaths = agents.reduce((n, a) => n + (a.stats.deaths ?? 0), 0);
    const kills = agents.reduce((n, a) => n + (a.stats.kills ?? 0), 0);
    console.log('fuzz ok actions', f.ok);
    console.log('fuzz errors', f.errors);
    console.log(`fuzz: kills ${kills}, deaths ${deaths}, levels ${levels.join(' ')}, unchanged-on-error checks ${f.unchanged}`);
    // The run must have exercised the game, not just bounced off validation.
    for (const action of ['move', 'attack', 'cast', 'gather', 'shop_buy', 'shop_sell', 'equip', 'use', 'quest_accept', 'talk', 'say', 'emote', 'take', 'drop', 'rest', 'release']) {
      expect(f.ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(kills).toBeGreaterThan(25);
    expect(deaths).toBeGreaterThan(0);
    expect(f.unchanged).toBeGreaterThan(500);
  });
});
