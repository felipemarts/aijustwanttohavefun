import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { checkInvariants } from './invariants';
import { nameAvailable, deactivateAgent } from './register';
import { exportAll, exportDirty, restoreWorld, type Snapshot } from './snapshot';
import { makeKit, MIN, type Kit } from './testkit';
import { tick } from './tick';
import type { Timer, WorldState } from './types';

/** Through JSON, like the database would. */
function persist(s: WorldState): Snapshot {
  return JSON.parse(JSON.stringify(exportAll(s))) as Snapshot;
}

function comparable(s: WorldState) {
  const snap = persist(s);
  for (const e of snap.world) if (e.key === 'timers') (e.data as Timer[]).sort((x, y) => x.at - y.at || JSON.stringify(x).localeCompare(JSON.stringify(y)));
  snap.world.sort((x, y) => x.key.localeCompare(y.key));
  return snap;
}

/** A world where a few things happened: kills, deaths, quests, items on the floor, gathered nodes. */
function playedWorld(): Kit {
  const k = makeKit(3);
  const w = k.add('Warri', 'warrior', { room: 'forest.edge' });
  const g = k.add('Magus', 'mage', { room: 'forest.path' });
  const c = k.add('Healer', 'cleric', { level: 5 });
  k.add('Wild', 'rogue', { claimed: false });
  k.ok(c, 'quest_accept', { quest: 't01_arrival' });
  for (let i = 0; i < 12; i++) {
    const m = k.monsters('forest.edge')[0];
    if (m) k.ok(w, 'attack', { target: m.uid });
    w.hp = k.maxHp(w);
  }
  k.ok(w, 'gather', { resource: 'wood' });
  k.ok(w, 'drop', { item: 'bread' });
  g.hp = 1;
  k.ok(g, 'attack', { target: 'wolf' });
  k.advance(2 * MIN);
  return k;
}

/** A village where agents befriended, partied, founded a guild, posted, traded and listed goods. */
function socialWorld(): Kit {
  const k = makeKit(5);
  const a = k.add('Pip', 'warrior', { room: 'village.guild_hall' });
  const b = k.add('Bob', 'mage', { room: 'village.guild_hall' });
  a.gold = 900;
  a.inv.iron_ore = 5;
  k.ok(a, 'friend_request', { agent: 'Bob' });
  k.ok(b, 'friend_accept', { agent: 'Pip' });
  k.ok(a, 'party_invite', { agent: 'Bob' });
  k.ok(b, 'party_accept', { agent: 'Pip' });
  k.ok(a, 'guild_create', { name: 'Iron Wolves', motto: 'Together' });
  k.ok(a, 'guild_invite', { agent: 'Bob' });
  k.ok(b, 'guild_join', { guild: 'Iron Wolves' });
  k.ok(a, 'guild_deposit', { gold: 50, items: { iron_ore: 1 } });
  k.ok(a, 'say', { text: 'hello' });
  k.advance(BALANCE.chat.sayCooldownMs);
  k.ok(b, 'say', { text: 'hi' });
  k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 10 }, want: {} });
  k.place(a, 'village.market');
  k.ok(a, 'market_sell', { item: 'iron_ore', qty: 2, price: 9 });
  k.s.village.treasury = 7;
  k.place(a, 'village.tavern');
  k.ok(a, 'board_post', { text: 'Wolves hiring', tag: 'lfg' });
  k.ok(a, 'journal', { text: 'A fine day.' });
  k.place(a, 'village.guild_hall');
  return k;
}

describe('snapshots', () => {
  it('exportAll -> restoreWorld round-trips a played world', () => {
    const k = playedWorld();
    const restored = restoreWorld(k.c, persist(k.s), k.now);
    expect(comparable(restored)).toEqual(comparable(k.s));
    expect(restored.roomAgents).toEqual(k.s.roomAgents);
    expect(restored.byName).toEqual(k.s.byName);
    expect(restored.bySkeleton).toEqual(k.s.bySkeleton);
    expect(restored.lookHashes).toEqual(k.s.lookHashes);
    expect(checkInvariants(restored, k.now)).toEqual([]);
    expect(nameAvailable(restored, 'warri').ok).toBe(false);
  });

  it('a restored world plays on exactly like the original', () => {
    const k = playedWorld();
    const copy = restoreWorld(k.c, persist(k.s), k.now);
    const script: [string, string, Record<string, unknown>][] = [
      ['Warri', 'attack', { target: 'slime' }],
      ['Warri', 'attack', { target: 'slime' }],
      ['Magus', 'release', {}],
      ['Healer', 'move', { dir: 'north' }],
      ['Warri', 'take', { item: 'bread' }],
      ['Warri', 'attack', { target: 'slime' }],
    ];
    const run = (s: WorldState) => {
      const rng = createRng(42);
      let now = k.now;
      const out: unknown[] = [];
      for (const [name, action, params] of script) {
        now += 5000;
        tick(s, { now, rng });
        const id = s.byName.get(name.toLowerCase())!;
        out.push(applyAction(s, { agentId: id, action, params }, { now, rng }));
      }
      now += 10 * MIN;
      out.push(tick(s, { now, rng }));
      return out;
    };
    expect(run(copy)).toEqual(run(k.s));
    expect(comparable(copy)).toEqual(comparable(k.s));
  });

  it('a fallen agent saved with its timer wakes after the restore', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.hp = 1;
    a.gold = 100;
    k.ok(a, 'attack', { target: 'slime' });
    const s = restoreWorld(k.c, persist(k.s), k.now);
    tick(s, { now: k.now + BALANCE.death.fallenMs, rng: k.rng });
    const b = s.agents.get(a.id)!;
    expect(b.room).toBe(BALANCE.templeRoom);
    expect(b.gold).toBe(90);
  });

  it('tolerates content changes: unknown items, rooms, monsters, quests and timers', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    const b = k.add('Bob', 'warrior', { room: 'forest.glade' });
    const r = k.add('Retiree', 'warrior');
    deactivateAgent(k.s, r.id, 'retired');
    const snap = persist(k.s);
    const sa = snap.agents.find((x) => x.id === a.id)!;
    sa.inv.excalibur = 1;
    sa.inv.wood = 3;
    sa.equip.weapon = 'excalibur';
    sa.quests.q_removed = { steps: [1], at: 0 };
    snap.agents.find((x) => x.id === b.id)!.room = 'forest.atlantis';
    const timers = snap.world.find((e) => e.key === 'timers')!.data as Timer[];
    timers.push({ at: k.now + MIN, kind: 'respawn', room: 'forest.atlantis', slot: 0 }, { at: k.now + MIN, kind: 'respawn', room: 'forest.edge', slot: 99 });
    snap.world.push({ key: 'room:forest.atlantis', data: { id: 'forest.atlantis', monsters: [], resources: {}, ground: {} } });
    const edge = snap.world.find((e) => e.key === 'room:forest.edge')!.data as WorldState['rooms'] extends Map<string, infer R> ? R : never;
    edge.ground = { excalibur: 1, bread: 2 };
    edge.monsters[0]!.kind = 'dragon';
    edge.monsters[1]!.kind = 'wolf';
    // The glade and every night slot lose their saved state.
    snap.world = snap.world.filter((e) => e.key !== 'room:forest.glade');

    const s = restoreWorld(k.c, snap, k.now);
    const a2 = s.agents.get(a.id)!;
    expect(a2.inv).toEqual({ cloth_armor: 1, bread: 3, wood: 3 });
    expect(a2.equip.weapon).toBeNull();
    expect(a2.quests).toEqual({});
    expect(snap.agents.find((x) => x.id === a.id)!.inv.excalibur).toBe(1);
    const b2 = s.agents.get(b.id)!;
    expect(b2.room).toBe(BALANCE.startRoom);
    expect(s.roomAgents.get(BALANCE.startRoom)!.has(b.id)).toBe(true);
    expect(s.rooms.has('forest.atlantis')).toBe(false);
    expect(s.rooms.get('forest.edge')!.ground).toEqual({ bread: 2 });
    // The two broken slimes were replaced by fresh ones.
    expect(s.rooms.get('forest.edge')!.monsters.map((m) => m.kind)).toEqual(['slime', 'slime', 'slime']);
    // The glade got fresh monsters, and its night creature still comes at nightfall.
    expect(s.rooms.get('forest.glade')!.monsters.map((m) => m.kind)).toEqual(['wolf', 'wolf', 'wolf']);
    tick(s, { now: k.now + BALANCE.day.night * BALANCE.day.lengthMs, rng: k.rng });
    expect(s.rooms.get('forest.glade')!.monsters.some((m) => m.kind === 'shadow_wolf')).toBe(true);
    // Retired agents keep their name but stand nowhere.
    expect(nameAvailable(s, 'Retiree').ok).toBe(false);
    expect([...s.roomAgents.values()].some((set) => set.has(r.id))).toBe(false);
    expect(s.timers.toJSON().some((t) => t.kind === 'respawn' && (t.room === 'forest.atlantis' || t.slot === 99))).toBe(false);
    expect(checkInvariants(s, k.now)).toEqual([]);
  });

  it('round-trips parties, guilds, bonds, trades, market orders, the board and the village', () => {
    const k = socialWorld();
    const restored = restoreWorld(k.c, persist(k.s), k.now);
    expect(comparable(restored)).toEqual(comparable(k.s));
    expect(restored.guildNames).toEqual(k.s.guildNames);
    expect(restored.guildSkeletons).toEqual(k.s.guildSkeletons);
    expect(restored.tradesOf).toEqual(k.s.tradesOf);
    expect(restored.ordersOf).toEqual(k.s.ordersOf);
    expect(restored.ordersByItem).toEqual(k.s.ordersByItem);
    expect(checkInvariants(restored, k.now)).toEqual([]);
    // And it keeps working: the pending trade can still be accepted.
    const bob = [...restored.agents.values()].find((a) => a.name === 'Bob')!;
    const trade = [...restored.trades.keys()][0]!;
    expect(applyAction(restored, { agentId: bob.id, action: 'trade_accept', params: { trade } }, { now: k.now + 1000, rng: k.rng }).result.ok).toBe(true);
  });

  it('exports a dissolved party or guild as null, and a restore ignores it', () => {
    const k = socialWorld();
    exportDirty(k.s);
    const pip = [...k.s.agents.values()].find((a) => a.name === 'Pip')!;
    const bob = [...k.s.agents.values()].find((a) => a.name === 'Bob')!;
    const partyId = pip.party!;
    const guildId = pip.guild!;
    k.ok(pip, 'party_leave');
    k.ok(bob, 'guild_leave');
    k.ok(pip, 'guild_leave');
    const snap = exportDirty(k.s);
    expect(snap.world).toEqual(expect.arrayContaining([{ key: `party:${partyId}`, data: null }, { key: `guild:${guildId}`, data: null }]));
    const all = persist(k.s);
    all.world.push(...JSON.parse(JSON.stringify(snap.world)));
    const restored = restoreWorld(k.c, all, k.now);
    expect(restored.parties.size).toBe(0);
    expect(restored.guilds.size).toBe(0);
    expect(checkInvariants(restored, k.now)).toEqual([]);
  });

  it('loads snapshots written before the social systems existed', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const snap = persist(k.s);
    const legacy = snap.agents.find((x) => x.id === a.id)! as unknown as Record<string, unknown>;
    for (const field of ['roomAt', 'friends', 'rivals', 'friendReqs', 'bonds', 'party', 'partyInvites', 'guild', 'guildInvites', 'duelInvites', 'journal']) delete legacy[field];
    snap.world = snap.world.filter((e) => !['trades', 'market', 'board', 'village'].includes(e.key));
    for (const e of snap.world) if (e.key.startsWith('room:')) delete (e.data as Record<string, unknown>).said;
    const meta = snap.world.find((e) => e.key === 'meta')!.data as Record<string, unknown>;
    for (const f of ['partySeq', 'guildSeq', 'tradeSeq', 'orderSeq', 'postSeq']) delete meta[f];
    const s = restoreWorld(k.c, snap, k.now);
    expect(checkInvariants(s, k.now)).toEqual([]);
    const b = s.agents.get(a.id)!;
    expect(b.friends).toEqual([]);
    expect(b.party).toBeNull();
    expect(s.village).toMatchObject({ taxRate: 0, treasury: 0 });
    const r = applyAction(s, { agentId: a.id, action: 'say', params: { text: 'still here' } }, { now: k.now + 1000, rng: k.rng });
    expect(r.result.ok).toBe(true);
    expect(s.meta.partySeq).toBe(0);
  });

  it('exportDirty returns only what changed and clears the set', () => {
    const k = makeKit();
    exportDirty(k.s);
    const a = k.add('Pip', 'warrior');
    exportDirty(k.s);
    k.ok(a, 'move', { dir: 'north' });
    const snap = exportDirty(k.s);
    expect(snap.agents.map((x) => x.id)).toEqual([a.id]);
    expect(snap.world).toEqual([]);
    expect(exportDirty(k.s)).toEqual({ agents: [], world: [] });
  });
});
