import { describe, expect, it } from 'vitest';
import { createRng, type GameEvent, type Rng } from '@ajwf/shared';
import { touch } from './agent';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { CLASSES, type Cmd } from './fuzzkit';
import { checkInvariants } from './invariants';
import { newRun } from './run';
import { HOUR, makeKit, MIN, SEC, worldWealth, type Kit } from './testkit';
import { tick } from './tick';
import type { AgentState, ApplyResult } from './types';

/**
 * Lawless fuzz: agents of mixed levels in the swamp, the ruins and the village at all hours attack each other
 * (party mates included), cast at each other, revive, pick pockets, give on trust, report scams, place bounties,
 * loot their guild treasury and stage coups. The lawless rooms are emptied of monsters, so nothing creates or
 * destroys gold or items: the world's whole wealth must stay exactly the same after every step. Also checked after
 * every step: the invariants, that a refused action changed nothing, that equipped items never move, and that
 * nobody below level 8 is ever attacked or robbed.
 */

const LAWLESS = ['swamp.marsh_edge', 'swamp.reeds', 'ruins.road', 'ruins.plaza'];
const HOMES = [...LAWLESS, ...LAWLESS, 'village.square'];
const ACTIONS = [
  'attack', 'attack', 'attack', 'attack', 'attack', 'attack', 'cast', 'cast', 'cast', 'steal', 'steal', 'give', 'give', 'report_scam', 'place_bounty', 'place_bounty', 'revive', 'release',
  'guild_vote_coup', 'guild_withdraw', 'guild_deposit', 'party_invite', 'party_accept', 'party_leave', 'say', 'inventory',
];
/** Events that hit an agent: never allowed against anyone below the PvP level. */
const HOSTILE = new Set(['pvp_kill', 'steal', 'steal_failed', 'betrayal']);

function command(k: Kit, rng: Rng, a: AgentState, agents: AgentState[]): Cmd {
  const s = k.s;
  const here = agents.filter((x) => x !== a && x.room === a.room && x.status === 'active');
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? rng.pick(xs) : undefined);
  const someone = () => (rng.chance(0.9) ? pick(here)?.name : undefined) ?? rng.pick(agents).name;
  if (a.fallen) return { action: rng.chance(0.5) ? 'release' : 'say', params: { text: 'help!' } };
  const invite = Object.keys(a.partyInvites)[0];
  if (invite && rng.chance(0.6)) return { action: 'party_accept', params: { agent: s.agents.get(invite)!.name } };
  const down = here.find((x) => x.fallen);
  if (down && a.cls === 'cleric' && rng.chance(0.6)) return { action: 'revive', params: { target: down.name } };
  const action = rng.pick(ACTIONS);
  switch (action) {
    case 'attack': {
      // Mostly finish off the weakest one standing here, so fights end in kills.
      const weakest = here.filter((x) => !x.fallen).sort((x, y) => x.hp - y.hp)[0];
      // Bounty hunters go after the heads with a price on them.
      const hunted = here.find((x) => !x.fallen && s.bounties[x.id]);
      if (hunted && rng.chance(0.6)) return { action, params: { target: hunted.name } };
      return { action, params: { target: weakest && rng.chance(0.7) ? weakest.name : someone() } };
    }
    case 'cast': {
      const skill = rng.pick(k.c.classes.get(a.cls)!.skills);
      const kind = k.c.skills.get(skill)!.kind;
      const fallen = pick(here.filter((x) => x.fallen))?.name;
      return { action, params: { skill, target: kind === 'revive' ? (fallen ?? someone()) : kind === 'heal' ? pick([a.name, ...here.map((x) => x.name)]) : someone() } };
    }
    case 'revive':
      return { action, params: { target: pick(here.filter((x) => x.fallen))?.name ?? someone() } };
    case 'steal':
      return { action, params: { target: someone() } };
    case 'give': {
      const item = pick(Object.keys(a.inv));
      return { action, params: { to: someone(), ...(rng.chance(0.6) ? { gold: rng.int(1, 30) } : {}), ...(item && rng.chance(0.5) ? { items: { [item]: 1 } } : {}) } };
    }
    case 'report_scam': {
      const g = pick(a.gives);
      return { action, params: { agent: g && rng.chance(0.9) ? s.agents.get(g.to)!.name : someone(), event_id: g?.id ?? '1' } };
    }
    case 'place_bounty': {
      const infamous = agents.filter((x) => x !== a && x.infamy > 0).map((x) => x.name);
      return { action, params: { agent: pick(infamous) ?? someone(), gold: rng.int(10, 60) } };
    }
    case 'guild_withdraw':
    case 'guild_deposit': {
      const g = a.guild ? s.guilds.get(a.guild) : undefined;
      return { action, params: { gold: rng.int(1, action === 'guild_withdraw' ? Math.max(1, g?.treasury ?? 50) : 80) } };
    }
    case 'party_invite':
      return { action, params: { agent: someone() } };
    case 'say':
      return { action, params: { text: 'trust me' } };
    default:
      return { action, params: {} };
  }
}

describe('fuzz: lawless', () => {
  it('8,000 PvP, theft, gift, bounty and coup actions conserve every coin and item, never touch equipment or newcomers', () => {
    const k = makeKit(1313);
    const rng = createRng(2718);
    for (const room of LAWLESS) {
      k.s.rooms.get(room)!.monsters = [];
      k.s.respawns.delete(room);
    }
    // A clean slate of timers for those rooms: no monster ever comes back there.
    const timers = k.s.timers.toJSON().filter((t) => !(t.kind === 'respawn' && LAWLESS.includes(t.room)));
    k.s.timers.replace(timers);

    const agents: AgentState[] = [];
    for (let i = 0; i < 24; i++) {
      // Most are PvP-eligible, a few are newcomers who must stay untouchable.
      const level = i % 8 === 7 ? 3 + (i % 5) : 8 + (i % 9);
      const a = k.add(`Out${i}`, CLASSES[i % 4]!, { room: HOMES[i % HOMES.length], level });
      a.gold = rng.int(50, 600);
      // They arrive bruised from the road, so fights end before regeneration undoes them.
      a.hp = rng.int(20, 80);
      Object.assign(a.inv, { wolf_pelt: rng.int(0, 3), iron_ore: rng.int(0, 4), minor_potion: 1, lost_locket: i % 3 === 0 ? 1 : 0 });
      for (const [id, n] of Object.entries(a.inv)) if (!n) delete a.inv[id];
      agents.push(a);
    }
    // Two guilds with something in the treasury, and officers to loot it or to stage a coup.
    for (const [lead, ...members] of [agents.slice(0, 6), agents.slice(6, 11)]) {
      const home = lead!.room;
      k.place(lead!, 'village.guild_hall');
      lead!.gold += BALANCE.guild.cost + 400;
      k.ok(lead!, 'guild_create', { name: `Band of ${lead!.name}` });
      k.ok(lead!, 'guild_deposit', { gold: 400 });
      for (const m of members) {
        k.ok(lead!, 'guild_invite', { agent: m.name });
        k.ok(m, 'guild_join', { guild: `Band of ${lead!.name}` });
      }
      k.ok(lead!, 'guild_promote', { agent: members[0]!.name });
      k.ok(lead!, 'guild_promote', { agent: members[1]!.name });
      k.place(lead!, home);
    }
    // Parties of three in the same room, so betrayals can happen.
    for (let i = 12; i + 2 < agents.length; i += 3) {
      const [x, y, z] = agents.slice(i, i + 3) as [AgentState, AgentState, AgentState];
      for (const m of [y, z]) {
        k.place(m, x.room);
        k.ok(x, 'party_invite', { agent: m.name });
        k.ok(m, 'party_accept', { agent: x.name });
      }
    }
    const home = new Map(agents.map((a) => [a, a.room]));
    const newbies = new Set(agents.filter((a) => a.level < BALANCE.pvp.minLevel).map((a) => a.id));
    const equip = new Map(agents.map((a) => [a.id, JSON.stringify(a.equip)]));
    const wealth = worldWealth(k.s);
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const ok: Record<string, number> = {};
    const seen: Record<string, number> = {};
    let unchanged = 0;
    let a = agents[0]!;
    let burst = 0;
    const check = (events: GameEvent[], what: () => string) => {
      for (const e of events) {
        seen[e.type] = (seen[e.type] ?? 0) + 1;
        if (e.target && newbies.has(e.target) && (HOSTILE.has(e.type) || (e.type === 'attack' && e.payload.pvp))) throw new Error(`${what()}: ${e.type} against a newcomer`);
      }
      expect(worldWealth(k.s), what()).toEqual(wealth);
      for (const x of agents) if (JSON.stringify(x.equip) !== equip.get(x.id)) throw new Error(`${what()}: equipment of ${x.name} changed`);
      const bad = checkInvariants(k.s, k.now);
      if (bad.length) throw new Error(`${what()}:\n${bad.join('\n')}`);
    };
    for (let step = 0; step < 8000; step++) {
      if (burst-- <= 0) {
        a = rng.pick(agents);
        burst = rng.int(3, 12);
        // Hours pass now and then: infamy fades, Wanted ends, bounties lapse, leaders go quiet, night falls.
        k.now += rng.chance(0.04) ? rng.int(1, 30) * HOUR : rng.int(0, 3) * MIN;
        if (!a.fallen && a.room !== home.get(a) && rng.chance(0.5)) k.place(a, home.get(a)!);
        // The wilds wear people down: now and then someone here limps in badly hurt, an easy mark.
        const mark = rng.chance(0.25) ? rng.pick(agents.filter((x) => x.room === a.room && !x.fallen)) : undefined;
        if (mark) mark.hp = Math.min(mark.hp, rng.int(5, 25));
      } else k.now += rng.int(1, 8) * SEC;
      check(tick(k.s, k.ctx()), () => `tick before step ${step}`);
      const cmd = command(k, rng, a, agents);
      const what = () => `step ${step}: ${a.name} (lvl ${a.level}) ${cmd.action} ${JSON.stringify(cmd.params)}`;
      touch(newRun(k.s, k.now, k.rng, a), a, false);
      const before = JSON.stringify([a, k.s.rooms.get(a.room), k.s.bounties, a.guild ? k.s.guilds.get(a.guild) : null]);
      let r: ApplyResult;
      try {
        r = applyAction(k.s, { agentId: a.id, ...cmd }, k.ctx());
      } catch (e) {
        throw new Error(`${what()} threw ${(e as Error).stack}`, { cause: e });
      }
      if (r.result.ok) ok[cmd.action] = (ok[cmd.action] ?? 0) + 1;
      else if (r.events.length === 0) {
        expect(JSON.stringify([a, k.s.rooms.get(a.room), k.s.bounties, a.guild ? k.s.guilds.get(a.guild) : null]), what()).toBe(before);
        unchanged++;
      }
      check(r.events, what);
      // Someone fell: the next turn goes to a Cleric standing there, or to the fallen one (who may release).
      const fell = r.events.find((e) => e.type === 'fallen');
      if (fell && rng.chance(0.7)) {
        const victim = k.s.agents.get(fell.actor!)!;
        a = agents.find((x) => x.cls === 'cleric' && x.room === victim.room && !x.fallen && x.level >= 5) ?? victim;
        burst = 2;
      }
    }
    console.log('lawless fuzz ok actions', ok);
    console.log('lawless fuzz events', Object.fromEntries(Object.entries(seen).filter(([t]) => /pvp|betray|bounty|wanted|steal|scam|coup|loot|give/.test(t))));
    console.log(`lawless fuzz: unchanged-on-error checks ${unchanged}`);
    for (const action of ['attack', 'cast', 'steal', 'give', 'report_scam', 'place_bounty', 'revive', 'release', 'guild_vote_coup', 'guild_withdraw']) {
      expect(ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    for (const type of ['pvp_kill', 'betrayal', 'bounty_placed', 'bounty_claimed', 'wanted', 'wanted_cleared', 'steal', 'steal_failed', 'scam_reported', 'give']) {
      expect(seen[type] ?? 0, type).toBeGreaterThan(0);
    }
    expect(unchanged).toBeGreaterThan(300);
  });
});
