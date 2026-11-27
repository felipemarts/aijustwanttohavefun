import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { ANY_ACTION, CLASSES, fuzz, PUZZLE_ACTIONS } from './fuzzkit';
import { HOUR, makeKit, SEC, T0 } from './testkit';
import type { AgentState } from './types';

describe('fuzz: dungeon', () => {
  it('8,000 actions by parties in the dungeon and around the world boss keep every invariant and conserve gold', () => {
    // Starts shortly before the world boss is announced, and runs for about a day of game time.
    const k = makeKit(515, T0 + 19 * HOUR + 20 * 60 * SEC);
    const rng = createRng(31);
    const rooms = ['ruins.catacomb_stairs', 'dungeon.antechamber', 'dungeon.lever_hall', 'dungeon.trapped_corridor', 'dungeon.rune_door', 'dungeon.gate_hall', 'dungeon.boss_lair', 'hills.pass'];
    const agents: AgentState[] = [];
    for (let i = 0; i < rooms.length * 4; i++) {
      const a = k.add(`Delver${i}`, CLASSES[i % 4]!, { room: rooms[Math.floor(i / 4)], level: 15 + (i % 6) });
      a.gold = rng.int(50, 400);
      Object.assign(a.inv, { crystal: 3, greater_potion: 2, minor_potion: 2 });
      agents.push(a);
    }
    // Parties of four, one class each, formed through the actions.
    for (let p = 0; p < rooms.length; p++) {
      const [lead, ...rest] = agents.slice(p * 4, p * 4 + 4);
      for (const m of rest) {
        expect(k.act(lead!, 'party_invite', { agent: m.name }).result.ok).toBe(true);
        expect(k.act(m, 'party_accept', { agent: lead!.name }).result.ok).toBe(true);
      }
    }
    const actions = [...ANY_ACTION, ...PUZZLE_ACTIONS, 'party_leave', 'party_invite', 'party_accept'];
    const f = fuzz(k, rng, agents, 8_000, actions, new Map(agents.map((a) => [a, a.room])));
    console.log('dungeon fuzz ok actions', f.ok);
    console.log('dungeon fuzz errors', f.errors);
    const solved = agents.reduce((n, a) => n + (a.stats.puzzles_solved ?? 0), 0);
    const colossusKills = agents.reduce((n, a) => n + (a.stats.world_boss_kills ?? 0), 0);
    console.log(`dungeon fuzz: puzzles solved ${solved}, world boss kill credits ${colossusKills}, unchanged-on-error checks ${f.unchanged}`);
    for (const action of PUZZLE_ACTIONS) expect(f.ok[action] ?? 0, action).toBeGreaterThan(0);
    expect(solved).toBeGreaterThan(10);
    // The world boss came and went (killed or not) and the next one is scheduled.
    expect(k.s.worldBoss.next).toBeGreaterThan(T0 + 30 * HOUR);
    expect(f.unchanged).toBeGreaterThan(300);
  });
});
