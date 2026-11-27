import { describe, expect, it, vi } from 'vitest';
import { CLASSES, createRng } from '@ajwf/shared';
import { BALANCE } from './balance';
import { bondLevel, bondScore } from './bond';
import { addGuildMember } from './guild';
import { MAX_AGENTS_LISTED, seenAgents } from './observe';
import { makeKit, partyUp, type Kit } from './testkit';
import type { AgentState, WorldState } from './types';

const ROOM = 'village.river_bank';

/** Counts the ids handed out by iterating the set, however it is iterated. */
class CountingSet extends Set<string> {
  yielded = 0;
  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  override values(): SetIterator<string> {
    const inner = super.values();
    const it = {
      next: () => {
        const r = inner.next();
        if (!r.done) this.yielded++;
        return r;
      },
      [Symbol.iterator]() {
        return it;
      },
    };
    return it as unknown as SetIterator<string>;
  }
}

/** The implementation before it was bounded: one pass over the whole room, kept here as the reference. */
function seenBefore(s: WorldState, a: AgentState): { list: { name: string; rel?: string; bond?: string }[]; others: number } {
  const friends = new Set(a.friends);
  const rivals = new Set(a.rivals);
  const relOf = (b: AgentState) => {
    if (a.party && b.party === a.party) return 'party';
    if (friends.has(b.id)) return 'friend';
    if (a.guild && b.guild === a.guild) return 'guild';
    if (rivals.has(b.id)) return 'rival';
    return undefined;
  };
  const rank = { party: 0, friend: 1, guild: 2, rival: 3 };
  const buckets: AgentState[][] = [[], [], [], [], []];
  let total = 0;
  let strangers = 0;
  for (const id of s.roomAgents.get(a.room) ?? []) {
    if (id === a.id) continue;
    total++;
    const b = s.agents.get(id)!;
    const rel = relOf(b);
    if (rel) buckets[rank[rel]]!.push(b);
    else if (strangers++ < MAX_AGENTS_LISTED) buckets[4]!.push(b);
  }
  const list = buckets
    .flat()
    .slice(0, MAX_AGENTS_LISTED)
    .map((b) => {
      const rel = relOf(b);
      const bond = bondLevel(bondScore(a, b));
      return { name: b.name, ...(rel ? { rel } : {}), ...(bond ? { bond } : {}) };
    });
  return { list, others: total - list.length };
}

function guildOf(k: Kit, leader: AgentState, name: string): string {
  const back = leader.room;
  k.place(leader, 'village.guild_hall');
  leader.gold += BALANCE.guild.cost;
  k.ok(leader, 'guild_create', { name, colors: ['#112233', '#445566'] });
  k.place(leader, back);
  return leader.guild!;
}

/** Same relations in the same order, and the same agents for every relation the cap did not cut. */
function expectSameAsBefore(k: Kit, viewer: AgentState): void {
  const now = seenAgents(k.s, viewer);
  const before = seenBefore(k.s, viewer);
  expect(now.others).toBe(before.others);
  expect(now.list.map((x) => x.rel)).toEqual(before.list.map((x) => x.rel));
  const cut = before.list.length === MAX_AGENTS_LISTED ? before.list[MAX_AGENTS_LISTED - 1]!.rel : null;
  const names = (l: { name: string; rel?: string; bond?: string }[], rel?: string) =>
    l
      .filter((x) => x.rel === rel)
      .map((x) => `${x.name}:${x.bond ?? ''}`)
      .sort();
  for (const rel of [undefined, 'party', 'friend', 'guild', 'rival']) {
    // Within the relation cut by the cap, which ones make the list may differ (room order then, list order now).
    if (rel === cut) continue;
    expect(names(now.list, rel), String(rel)).toEqual(names(before.list, rel));
  }
}

describe('seenAgents', () => {
  it('touches a bounded number of agents in a room of 2,000, related ones first', () => {
    const k = makeKit();
    const viewer = k.add('Viewer', 'warrior', { room: ROOM, level: 10 });
    const crowd: AgentState[] = [];
    for (let i = 0; i < 2_000; i++) crowd.push(k.add(`Crowd${i}`, 'mage', { room: ROOM }));
    // Relations among the last arrivals, so a single pass in room order would only find them at the very end.
    const tail = crowd.slice(-6);
    partyUp(k, ROOM, viewer, tail[0]!);
    viewer.friends.push(tail[1]!.id, crowd[0]!.id);
    tail[1]!.friends.push(viewer.id);
    const g = guildOf(k, viewer, 'Bounded Lookers');
    addGuildMember(k.s, k.s.guilds.get(g)!, tail[2]!);
    viewer.rivals.push(tail[3]!.id);
    // A friend somewhere else is not shown.
    const away = k.add('Faraway', 'rogue', { room: 'village.square' });
    viewer.friends.push(away.id);

    const set = new CountingSet(k.s.roomAgents.get(ROOM)!);
    k.s.roomAgents.set(ROOM, set);
    const gets = vi.spyOn(k.s.agents, 'get');
    const seen = seenAgents(k.s, viewer);
    const touched = gets.mock.calls.length;
    gets.mockRestore();

    expect(seen.list.map((x) => [x.name, x.rel])).toEqual([
      [tail[0]!.name, 'party'],
      [tail[1]!.name, 'friend'],
      [crowd[0]!.name, 'friend'],
      [tail[2]!.name, 'guild'],
      [tail[3]!.name, 'rival'],
      ['Crowd1', undefined],
      ['Crowd2', undefined],
      ['Crowd3', undefined],
    ]);
    expect(seen.others).toBe(2_000 - MAX_AGENTS_LISTED);
    // Only the listed agents are read, and the room set is walked only until the list is full.
    expect(touched).toBe(MAX_AGENTS_LISTED);
    expect(set.yielded).toBeLessThanOrEqual(2 * MAX_AGENTS_LISTED);
  });

  it('gives the same result as the full pass in small rooms', () => {
    const rng = createRng(11);
    for (let round = 0; round < 60; round++) {
      const k = makeKit(round + 1);
      const viewer = k.add('Viewer', 'warrior', { room: ROOM, level: 10 });
      const n = rng.int(0, 14);
      const others = Array.from({ length: n }, (_, i) => k.add(`Crowd${i}`, CLASSES[i % 4]!, { room: ROOM }));
      const guild = rng.chance(0.5) ? guildOf(k, viewer, `Guild Round ${round}`) : null;
      const party: AgentState[] = [];
      for (const b of others) {
        const roll = rng.int(0, 6);
        if (roll === 0 && party.length < 3) party.push(b);
        if (roll === 1 || (roll === 2 && rng.chance(0.5))) viewer.friends.push(b.id);
        if (roll >= 2 && roll <= 3 && guild) addGuildMember(k.s, k.s.guilds.get(guild)!, b);
        if (roll === 4 || (roll === 3 && rng.chance(0.5))) viewer.rivals.push(b.id);
        if (rng.chance(0.3)) {
          const v = rng.int(1, BALANCE.bond.bestFriend);
          viewer.bonds[b.id] = { v, talk: 0 };
          b.bonds[viewer.id] = { v, talk: 0 };
        }
      }
      if (party.length) partyUp(k, ROOM, viewer, ...party);
      expectSameAsBefore(k, viewer);
    }
  });

  it('an empty room lists nobody', () => {
    const k = makeKit();
    const viewer = k.add('Viewer', 'warrior', { room: ROOM });
    expect(seenAgents(k.s, viewer)).toEqual({ list: [], others: 0 });
  });
});
