import { describe, expect, it } from 'vitest';
import { actionParamSchemas, createRng, isActionName, type ActionName } from '@ajwf/shared';
import { addItem } from './agent';
import { BALANCE } from './balance';
import { HOSTILE_NUMBERS, hostileStep, paramSlots, paramsWith, PROTO_NAMES, settle, worldBytes, type ParamSlot, type ValuePicker } from './fuzzkit';
import { checkInvariants } from './invariants';
import { makeKit, type Kit } from './testkit';
import type { AgentState } from './types';

/**
 * Hostile params straight into the engine. The boundary refuses `Object.prototype` names as ids and bounds every
 * number (schemas.ts); these tests skip it (`applyParsed`) to prove the engine holds on its own, against a new
 * parameter, an internal caller or anything else that does not pass through the schemas:
 * - every string of every action (fields, enum values, item-bundle keys), in turn, set to each prototype name;
 * - every number, in turn, set to hostile values, both through `applyAction` and around it.
 * Each call must refuse normally (no exception, no INTERNAL), leave the serialized world byte for byte as it was,
 * and keep every invariant. Only free text and read-only filters may take a prototype name and succeed.
 */

/** Free text: a prototype name is just text there. */
const FREE_TEXT = new Set(['text', 'platform', 'motto', 'language']);
/** Actions that only read: a hostile filter finds nothing, which is a normal answer. */
const READ_ONLY = new Set<ActionName>(['market_list', 'board_read', 'quest_list', 'inventory']);

const ACTIONS = Object.keys(actionParamSchemas).filter(isActionName);

/** The actor of each action: class actions need their class; everything else is done by the warrior (mayor, guild and party leader). */
function actorFor(action: ActionName, cast: AgentState[], w: AgentState, n: number): AgentState {
  const byClass: Partial<Record<ActionName, string>> = {
    steal: 'rogue', scout: 'rogue', pick_lock: 'rogue', disarm: 'rogue', hold_gate: 'warrior', taunt: 'warrior',
    enchant: 'mage', read_runes: 'mage', revive: 'cleric',
  };
  if (action === 'cast') return cast[n % cast.length]!;
  const cls = byClass[action];
  return cls ? cast.find((a) => a.cls === cls)! : w;
}

type World = { k: Kit; cast: AgentState[]; w: AgentState; others: AgentState[]; rooms: string[] };

/** A small world where most actions have something to point at: a guild, a party, a mayor, an election, orders, posts, trades, requests. */
function richWorld(): World {
  const k = makeKit(7);
  const c = k.c;
  const w = k.add('Wulf', 'warrior', { level: 10 });
  const m = k.add('Mira', 'mage', { level: 10 });
  const r = k.add('Rook', 'rogue', { level: 10 });
  const cl = k.add('Cleo', 'cleric', { level: 10 });
  const bob = k.add('Bobby', 'warrior', { level: 10 });
  const eve = k.add('Evelyn', 'rogue', { level: 10 });
  const cast = [w, m, r, cl];
  const everyone = [...cast, bob, eve];
  const items = [...c.items.values()].filter((i) => i.type !== 'quest');
  for (const a of everyone) {
    a.gold = 5_000;
    for (const it of items.filter((i) => i.type === 'material' || i.type === 'consumable').slice(0, 6)) addItem(a, it.id, 3);
  }
  const room = (flag: string) => [...c.rooms.values()].find((x) => x.flags.includes(flag as never))!.id;
  const gather = (where: string) => everyone.forEach((a) => k.place(a, where));

  // A mayor (the warrior), a treasury, and the next election in its voting phase with a candidate.
  gather(room('town_hall'));
  k.ok(w, 'run_for_mayor', { platform: 'Bridges for all' });
  k.advance(k.s.village.election.voteAt - k.now);
  k.ok(bob, 'vote', { candidate: 'Wulf' });
  k.advance(k.s.village.election.end - k.now);
  expect(k.s.village.mayor?.id).toBe(w.id);
  k.s.village.treasury = 2_000;
  k.ok(m, 'run_for_mayor', { platform: 'Books for all' });
  k.advance(k.s.village.election.voteAt - k.now);
  for (const a of everyone) k.refresh(a);

  // A guild led by the warrior, with the mage in it; a party of the warrior and the cleric.
  gather(room('guild_hall'));
  k.ok(w, 'guild_create', { name: 'Order of Tests' });
  k.ok(w, 'guild_invite', { agent: 'Mira' });
  k.ok(m, 'guild_join', { guild: 'Order of Tests' });
  k.ok(w, 'guild_deposit', { gold: 100 });
  k.ok(w, 'party_invite', { agent: 'Cleo' });
  k.ok(cl, 'party_accept', { agent: 'Wulf' });

  // The market and the board have something on them.
  gather(room('market'));
  const sold = items.find((i) => (eve.inv[i.id] ?? 0) > 0)!;
  k.ok(eve, 'market_sell', { item: sold.id, qty: 1, price: 5 });
  gather(room('board'));
  k.ok(eve, 'board_post', { text: 'Selling ore', tag: 'trade' });
  k.ok(bob, 'board_reply', { post: k.s.board[0]!.id, text: 'how much?' });

  // Requests waiting for an answer, a gift on record, someone with infamy for bounties.
  gather(room('training'));
  for (const [i, a] of cast.entries()) {
    k.ok(i < 2 ? bob : eve, 'trade_offer', { to: a.name, give: { gold: 1 }, want: {} });
    k.ok(bob, 'friend_request', { agent: a.name });
    k.act(bob, 'duel_invite', { agent: a.name });
  }
  k.ok(w, 'give', { to: 'Bobby', gold: 5 });
  eve.infamy = 5;
  eve.infamyAt = k.now;

  const rooms = new Set<string>();
  for (const f of ['board', 'tavern', 'guild_hall', 'plot', 'temple', 'town_hall', 'market', 'training']) rooms.add(room(f));
  for (const n of c.npcs.values()) if (n.shop) rooms.add(n.room);
  for (const pz of c.puzzles.values()) rooms.add(pz.room);
  rooms.add([...c.rooms.values()].find((x) => x.resources.length && x.monsters.length)!.id);
  return { k, cast, w, others: [bob, eve], rooms: [...rooms] };
}

/** Ordinary values for the other params, from what the actor can see and carries where it stands. */
function picker(world: World, a: AgentState, rng: ReturnType<typeof createRng>): ValuePicker {
  const { k } = world;
  const c = k.c;
  const s = k.s;
  const def = c.rooms.get(a.room)!;
  const st = s.rooms.get(a.room)!;
  const npcs = c.npcsByRoom.get(a.room) ?? [];
  const names = [...s.agents.values()].filter((x) => x !== a).map((x) => x.name);
  const pools: Record<string, () => string[]> = {
    dir: () => Object.keys(def.exits),
    target: () => [...Object.keys(def.exits), ...st.monsters.map((x) => x.uid), ...names, ...(c.puzzlesByRoom.get(a.room) ?? []).flatMap((pz) => pz.targets), 'winch'],
    skill: () => c.classes.get(a.cls)!.skills,
    resource: () => def.resources.map((x) => x.id),
    recipe: () => [...c.recipes.keys()],
    project: () => [...c.projects.keys()],
    item: () => [...Object.keys(a.inv), ...Object.keys(st.ground), ...Object.values(a.equip).filter((x): x is string => !!x)],
    npc: () => npcs.map((x) => x.id),
    topic: () => npcs.flatMap((x) => x.topics),
    order: () => Object.keys(s.market.orders),
    quest: () => [...npcs.flatMap((x) => (c.questsByGiver.get(x.id) ?? []).map((q) => q.id)), ...Object.keys(a.quests)],
    emote: () => [...c.emotes.keys()],
    to: () => names,
    agent: () => names,
    candidate: () => names,
    trade: () => [...s.trades.keys()],
    guild: () => [...s.guilds.values()].map((g) => g.name),
    plot: () => [...c.rooms.values()].filter((x) => x.flags.includes('plot')).map((x) => x.id),
    event_id: () => a.gives.map((g) => g.id),
    post: () => s.board.map((p) => p.id),
    title: () => a.titles,
    language: () => ['en', 'pt-BR'],
    name: () => ['Hall of Fuzz'],
    text: () => ['hello there'],
    platform: () => ['Roads for all'],
    motto: () => ['Onward'],
    colors: () => ['#112233'],
  };
  const nums: Record<string, number> = { qty: 1, gold: 10, price: 5, rate: 0.02 };
  return {
    str: (field) => {
      const pool = pools[field]?.() ?? [];
      return pool.length ? rng.pick(pool) : 'x';
    },
    num: (field) => nums[field] ?? 1,
  };
}

/** A skill cast on oneself or the party: its `target` param is not read. */
function ignoresTarget(world: World, action: ActionName, params: unknown): boolean {
  const skill = world.k.c.skills.get(String((params as { skill?: unknown }).skill));
  return action === 'cast' && !!skill && ['buff', 'shield', 'party_heal', 'escape'].includes(skill.kind);
}

/** Puts everyone in the room, brought up to date at this instant, with full AP. */
function stage(world: World, room: string): void {
  for (const a of [...world.cast, ...world.others]) {
    if (a.room !== room && !a.fallen) world.k.place(a, room);
    settle(world.k, a);
    a.ap = BALANCE.ap.max;
  }
}

function sweep(world: World, kind: ParamSlot['kind'], values: readonly unknown[], viaSchema: boolean): { calls: number; ok: number; codes: Record<string, number> } {
  const { k, cast, w } = world;
  const rng = createRng(11);
  const stats = { calls: 0, ok: 0, codes: {} as Record<string, number> };
  for (const room of world.rooms) {
    stage(world, room);
    let before = worldBytes(k.s);
    let n = 0;
    for (const action of ACTIONS) {
      for (const slot of paramSlots(action).filter((x) => x.kind === kind)) {
        for (const value of values) {
          const a = actorFor(action, cast, w, n++);
          const params = paramsWith(action, slot, value, picker(world, a, rng), rng);
          const what = `${room}: ${a.name} ${action} ${slot.path.join('.')}=${String(value)} ${JSON.stringify(params)}`;
          const out = hostileStep(k, a, action, params, before, what, viaSchema);
          stats.calls++;
          if (!out.ok) {
            stats.codes[out.code!] = (stats.codes[out.code!] ?? 0) + 1;
            continue;
          }
          stats.ok++;
          if (kind === 'string') {
            // A prototype name may only be accepted as free text, as a filter that finds nothing, or where the action
            // ignores the param (a self-cast skill given a target).
            expect(FREE_TEXT.has(slot.field) || READ_ONLY.has(action) || ignoresTarget(world, action, params), `${what} succeeded`).toBe(true);
          } else {
            // A hostile number may only be accepted where it is in fact a valid amount (-0 for an optional gold).
            expect(Number.isSafeInteger(value) || (action === 'mayor_tax' && typeof value === 'number'), `${what} succeeded`).toBe(true);
          }
          // The action went through (and may have moved someone): set the stage again.
          stage(world, room);
          before = worldBytes(k.s);
        }
      }
    }
  }
  return stats;
}

describe('hostile params', () => {
  it('every string param of every action, set to each Object.prototype name, is refused and changes nothing', () => {
    const world = richWorld();
    expect(checkInvariants(world.k.s, world.k.now)).toEqual([]);
    const slots = ACTIONS.flatMap((a) => paramSlots(a).filter((x) => x.kind === 'string'));
    // Item-bundle keys are covered (trade_offer, give, contribute, guild deposits).
    expect(slots.some((x) => x.action === 'trade_offer' && x.path.join('.') === 'give.items.u0.k')).toBe(true);
    const stats = sweep(world, 'string', PROTO_NAMES, false);
    expect(stats.calls).toBeGreaterThan(slots.length * PROTO_NAMES.length * world.rooms.length * 0.9);
    // The refusals are the ordinary ones: not found, not here, not allowed...
    expect(Object.keys(stats.codes)).not.toContain('INTERNAL');
    expect(stats.codes.TARGET_NOT_FOUND).toBeGreaterThan(100);
  });

  it('hostile numbers are refused at the boundary, change nothing, and break no invariant', () => {
    const world = richWorld();
    const stats = sweep(world, 'number', HOSTILE_NUMBERS.filter((x) => !Number.isNaN(x)), true);
    expect(stats.calls).toBeGreaterThan(500);
    expect(stats.codes.INVALID_PARAMS).toBeGreaterThan(stats.calls * 0.5);
  });

  it('hostile numbers that skip the schemas are still refused by the engine, which changes nothing', () => {
    const world = richWorld();
    const stats = sweep(world, 'number', HOSTILE_NUMBERS, false);
    expect(stats.calls).toBeGreaterThan(500);
    expect(Object.keys(stats.codes)).not.toContain('INTERNAL');
  });
});
