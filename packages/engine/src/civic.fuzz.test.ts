import { describe, expect, it } from 'vitest';
import { createRng, type ClassId, type GameEvent, type Rng } from '@ajwf/shared';
import { touch } from './agent';
import { applyAction } from './apply';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { deactivateAgent } from './register';
import { newRun } from './run';
import { HOUR, makeKit, SEC, worldWealth, type Kit } from './testkit';
import { tick } from './tick';
import type { AgentState, ApplyResult, WorldState } from './types';
import { missingFor, projectStatus } from './village';

/**
 * Civic fuzz: agents contribute to projects, run for mayor, vote, govern, found guilds and build halls, trade at
 * the market (which feeds the treasury), while the clock runs through several weekly elections. After every step:
 * the invariants hold, a refused action changed nothing, and gold and items only left circulation through the
 * sinks the events declare.
 */

const CLASSES: ClassId[] = ['warrior', 'mage', 'rogue', 'cleric'];
const ROOMS = ['village.town_hall', 'village.town_hall', 'village.river_bank', 'village.plot_ne', 'village.tavern', 'village.market', 'village.guild_hall', 'village.plot_s', 'village.plot_se', 'village.plot_sw', 'village.square'];
const MATERIALS = ['wood', 'stone', 'iron_ingot', 'linen', 'pot', 'crystal', 'silver_ore', 'buckle', 'ancient_relic', 'bread'];
const PROJECTS = ['bridge', 'watchtower', 'inn_expansion', 'library', 'covered_market', 'arena', 'wall', 'statue', 'castle'];
const PLOTS = ['village.plot_s', 'village.plot_se', 'village.plot_far', 'village.plot_ne', 'plot_s', 'village.square', 'nowhere'];
const ACTIONS = [
  'contribute', 'contribute', 'contribute', 'run_for_mayor', 'vote', 'vote', 'mayor_priority', 'mayor_tax', 'mayor_fund', 'mayor_embezzle',
  'guild_create', 'guild_invite', 'guild_join', 'guild_deposit', 'guild_build_hall', 'guild_leave', 'market_sell', 'market_buy', 'move',
];

type Cmd = { action: string; params: Record<string, unknown> };

function command(k: Kit, rng: Rng, a: AgentState): Cmd {
  const s = k.s;
  const pick = <T>(xs: readonly T[]): T => rng.pick(xs);
  const o = observe(s, a.id, k.ctx());
  const goods = () => {
    const items: Record<string, number> = {};
    for (let i = rng.int(0, 3); i > 0; i--) items[pick(MATERIALS)] = rng.int(1, 40);
    return { ...(rng.chance(0.6) ? { gold: rng.int(1, 600) } : {}), ...(Object.keys(items).length ? { items } : {}) };
  };
  // A little intent: the mayor governs, guild leaders save up for a hall, voters vote, givers give what is needed.
  const civic = o.actions.filter((x) => ACTIONS.includes(x));
  const g = a.guild ? s.guilds.get(a.guild) : undefined;
  if (s.village.mayor?.id === a.id && rng.chance(0.4)) return command2(k, rng, a, pick(['mayor_priority', 'mayor_tax', 'mayor_fund', 'mayor_embezzle', 'mayor_fund']), goods);
  if (g?.leader === a.id && rng.chance(0.5)) {
    if (rng.chance(0.5)) {
      const items: Record<string, number> = {};
      for (const m of ['wood', 'stone']) if (a.inv[m]) items[m] = Math.min(a.inv[m], rng.int(5, 20));
      return { action: 'guild_deposit', params: { gold: Math.max(1, Math.min(a.gold, rng.int(100, 400))), items } };
    }
    return { action: 'guild_build_hall', params: { plot: pick(PLOTS) } };
  }
  if (civic.includes('vote') && rng.chance(0.6)) return command2(k, rng, a, 'vote', goods);
  const open = [...(o.room.projects ?? []).map((x) => x.id), ...(o.room.project && !o.room.project.done ? [o.room.project.id] : [])];
  if (open.length && rng.chance(0.5)) {
    const proj = s.content.projects.get(pick(open))!;
    const st = s.village.projects[proj.id];
    const items: Record<string, number> = {};
    for (const x of proj.cost.items) if (rng.chance(0.5)) items[x.item] = rng.int(1, Math.max(1, x.qty - (st?.items[x.item] ?? 0) + 3));
    return { action: 'contribute', params: { project: proj.id, ...(rng.chance(0.5) ? { gold: rng.int(1, 400) * costScale(s) } : {}), ...(Object.keys(items).length ? { items } : {}) } };
  }
  return command2(k, rng, a, rng.chance(0.3) && civic.length ? pick(civic) : pick(ACTIONS), goods);
}

function command2(k: Kit, rng: Rng, a: AgentState, action: string, goods: () => Record<string, unknown>): Cmd {
  const s = k.s;
  const pick = <T>(xs: readonly T[]): T => rng.pick(xs);
  const names = [...s.agents.values()].map((x) => x.name);
  switch (action) {
    case 'contribute':
      return { action, params: { project: pick(PROJECTS), ...goods() } };
    case 'run_for_mayor':
      return { action, params: { platform: pick(['Bridges!', 'Low taxes, high walls.', 'see https://x.example', '​']) } };
    case 'vote': {
      const cands = s.village.election.candidates.map((c) => c.name);
      return { action, params: { candidate: cands.length && rng.chance(0.85) ? pick(cands) : pick(names) } };
    }
    case 'mayor_priority':
      return { action, params: { project: pick(PROJECTS) } };
    case 'mayor_tax':
      return { action, params: { rate: rng.chance(0.9) ? rng.int(0, 10) / 100 : 0.5 } };
    case 'mayor_fund': {
      const open = [...s.content.projects.values()].filter((p) => projectStatus(s, p) === 'available' && missingFor(s, p).gold > 0).map((p) => p.id);
      return { action, params: { project: open.length && rng.chance(0.8) ? pick(open) : pick(PROJECTS), gold: rng.int(1, Math.max(1, Math.min(400, s.village.treasury + 20))) } };
    }
    case 'mayor_embezzle':
      return { action, params: { gold: rng.int(1, Math.max(1, Math.ceil(s.village.treasury / 8))) } };
    case 'guild_create':
      return { action, params: { name: `Guild of ${a.name}` } };
    case 'guild_invite':
      return { action, params: { agent: pick(names) } };
    case 'guild_join':
      return { action, params: { guild: s.guilds.size ? pick([...s.guilds.values()].map((g) => g.name)) : 'none' } };
    case 'guild_deposit':
      return { action, params: goods() };
    case 'guild_build_hall':
      return { action, params: { plot: pick(PLOTS) } };
    case 'market_sell':
      return { action, params: { item: pick(MATERIALS), qty: rng.int(1, 5), price: rng.int(1, 80) } };
    case 'market_buy': {
      const ids = Object.keys(s.market.orders);
      return { action, params: { order: ids.length ? pick(ids) : 'o1' } };
    }
    case 'move':
      return { action, params: { dir: pick(Object.keys(s.content.rooms.get(a.room)!.exits)) } };
    default:
      return { action, params: {} };
  }
}

/** Gold and items that the events say left circulation (sinks), or entered it. */
function flows(events: GameEvent[], acc: { gold: number; items: Record<string, number> }): void {
  const sub = (items: Record<string, number> | undefined) => {
    for (const [id, n] of Object.entries(items ?? {})) acc.items[id] = (acc.items[id] ?? 0) - n;
  };
  for (const e of events) {
    const p = e.payload as Record<string, unknown> & { gold?: number; items?: Record<string, number> };
    switch (e.type) {
      case 'project_contribution':
        acc.gold -= p.gold ?? 0;
        sub(p.items);
        break;
      case 'mayor_fund':
        acc.gold -= p.gold ?? 0;
        break;
      case 'guild_hall_built': {
        const cost = p.cost as { gold?: number; items?: Record<string, number> };
        acc.gold -= cost.gold ?? 0;
        sub(cost.items);
        break;
      }
      case 'guild_founded':
        acc.gold -= p.cost as number;
        break;
      case 'guild_disbanded': {
        const lost = p.lost as { gold: number; items: Record<string, number> };
        acc.gold -= lost.gold;
        sub(lost.items);
        break;
      }
    }
  }
}

function clean(items: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(items).filter(([, n]) => n !== 0));
}

/** How many times the bridge costs more than the 500 gold this test was written for. */
function costScale(s: WorldState): number {
  return Math.max(1, Math.round(s.content.projects.get('bridge')!.cost.gold / 500));
}

describe('civic fuzz', () => {
  it('6,000 civic actions over several elections keep every invariant and conserve gold and items', () => {
    const k = makeKit(808);
    const rng = createRng(31);
    const agents: AgentState[] = [];
    for (let i = 0; i < 20; i++) {
      const level = i % 10 === 9 ? 2 : i % 4 === 0 ? 3 : 5 + (i % 4);
      const a = k.add(`Civ${i}`, CLASSES[i % 4]!, { claimed: i % 10 !== 7, room: ROOMS[i % ROOMS.length], level: i % 10 === 7 ? 3 : level });
      // Wealth in proportion to what projects cost (a tuning number of the content), so some of them get built.
      a.gold = rng.int(500, 3000) * costScale(k.s);
      for (const m of MATERIALS) a.inv[m] = rng.int(5, 60) * costScale(k.s);
      agents.push(a);
    }
    // Three guilds start out, half-way to affording a hall.
    for (const i of [1, 5, 13]) {
      const a = agents[i]!;
      const home = a.room;
      k.place(a, 'village.guild_hall');
      a.gold += 1500;
      a.inv.wood! += 40;
      a.inv.stone! += 40;
      k.ok(a, 'guild_create', { name: `Hall Fund ${i}` });
      k.ok(a, 'guild_deposit', { gold: 900, items: { wood: 35, stone: 35 } });
      k.place(a, home);
    }
    // The treasury starts with something to spend, embezzle and fund with.
    k.s.village.treasury = 3000;
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const ok: Record<string, number> = {};
    const errors: Record<string, number> = {};
    let unchanged = 0;
    let wealth = worldWealth(k.s);
    let a = agents[0]!;
    let burst = 0;
    const results: string[] = [];
    const home = new Map(agents.map((x) => [x, x.room]));
    let banned = false;
    for (let step = 0; step < 6000; step++) {
      if (burst-- <= 0) {
        a = rng.pick(agents.filter((x) => x.status === 'active'));
        burst = rng.int(1, 6);
        k.now += rng.chance(0.06) ? rng.int(2, 24) * HOUR : rng.int(0, 300) * SEC;
        // Wanderers walk back home now and then, so the town hall and the plots stay busy.
        if (!a.combat && a.room !== home.get(a) && rng.chance(0.3)) k.place(a, home.get(a)!);
      } else k.now += rng.int(1, 10) * SEC;
      const acc = { gold: wealth.gold, items: { ...wealth.items } };
      const tickEvents = tick(k.s, k.ctx());
      for (const e of tickEvents) if (e.type === 'election_result') results.push(String(e.payload.winner));
      flows(tickEvents, acc);
      // Once, in the middle of a voting phase, a candidate is banned.
      if (!banned && k.s.village.election.phase === 'voting' && k.s.village.election.candidates.length > 1) {
        const c = k.s.agents.get(k.s.village.election.candidates[0]!.id)!;
        if (c !== a) {
          deactivateAgent(k.s, c.id, 'banned');
          banned = true;
        }
      }

      const cmd = command(k, rng, a);
      const what = () => `step ${step}: ${a.name} ${cmd.action} ${JSON.stringify(cmd.params)}`;
      touch(newRun(k.s, k.now, k.rng, a), a, false);
      const before = JSON.stringify([a, k.s.village, a.guild ? k.s.guilds.get(a.guild) : null]);
      let r: ApplyResult;
      try {
        r = applyAction(k.s, { agentId: a.id, ...cmd }, k.ctx());
      } catch (e) {
        throw new Error(`${what()} threw ${(e as Error).stack}`, { cause: e });
      }
      if (r.result.ok) ok[cmd.action] = (ok[cmd.action] ?? 0) + 1;
      else {
        errors[r.result.error.msg.k] = (errors[r.result.error.msg.k] ?? 0) + 1;
        if (r.events.length === 0) {
          expect(JSON.stringify([a, k.s.village, a.guild ? k.s.guilds.get(a.guild) : null]), what()).toBe(before);
          unchanged++;
        }
      }
      flows(r.events, acc);
      wealth = worldWealth(k.s);
      if (wealth.gold !== acc.gold) throw new Error(`${what()}: gold ${wealth.gold}, expected ${acc.gold}`);
      expect(clean(wealth.items), what()).toEqual(clean(acc.items));
      const bad = checkInvariants(k.s, k.now);
      if (bad.length) throw new Error(`${what()}:\n${bad.join('\n')}`);
    }
    const done = Object.entries(k.s.village.projects).filter(([, st]) => st.doneAt !== undefined).map(([id]) => id);
    console.log('civic fuzz ok actions', ok);
    console.log('civic fuzz errors', errors);
    console.log(`civic fuzz: elections ${results.join(', ')}; projects done ${done.join(', ')}; halls ${Object.keys(k.s.village.halls).length}; unchanged-on-error ${unchanged}`);
    for (const action of ['contribute', 'run_for_mayor', 'vote', 'mayor_priority', 'mayor_tax', 'mayor_fund', 'mayor_embezzle', 'guild_create', 'guild_build_hall', 'market_buy']) {
      expect(ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.some((w) => w !== 'null')).toBe(true);
    expect(done.length).toBeGreaterThan(0);
    expect(banned).toBe(true);
    expect(unchanged).toBeGreaterThan(500);
  });
});
