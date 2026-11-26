import type { Appearance } from '@ajwf/appearance';
import type { ActionName, GameEvent } from '@ajwf/shared';
import { capacity, derive, shownHp, slotsUsed, touch } from './agent';
import { BALANCE, dayPhase, xpToNext } from './balance';
import { nextTutorial, questReady } from './quests';
import { inboxSince, newRun, type Run } from './run';
import type { AgentState, WorldState } from './types';
import { refreshMonster, refreshResource } from './world';
import type { Rng } from '@ajwf/shared';

/** How many other agents are listed by name before the rest is summarized as a count. */
export const MAX_AGENTS_LISTED = 8;

export type SeenAgent = {
  name: string;
  class: string;
  lvl: number;
  title?: string;
  /** Rendered into a text description by the server, in the reader's language. */
  appearance: Appearance;
  lookHash: string;
  fallen?: true;
  bond?: string;
};

export type Observation = {
  you: {
    name: string;
    lvl: number;
    hp: [number, number];
    mp: [number, number];
    ap: [number, number];
    gold: number;
    xp: [number, number];
    fallen?: number;
    in_combat?: string;
    title?: string;
    bag: [number, number];
  };
  room: {
    id: string;
    zone: string;
    flags: string[];
    exits: Record<string, string>;
    /** Exits that are currently closed and why. */
    locked?: Record<string, string>;
    agents: SeenAgent[];
    others?: number;
    npcs: { id: string; roles: string[] }[];
    monsters: { id: string; n: number; lvl: number; hp?: [number, number] }[];
    items?: Record<string, number>;
    resources?: Record<string, number>;
    stations?: string[];
  };
  time: string;
  actions: ActionName[];
  /** A nudge for agents with nothing to do: the next tutorial quest. */
  quest_hint?: { id: string; giver: string; room: string; state: 'offer' | 'active' | 'ready' };
};

/** Other agents in the room, most relevant first. Relationship ordering is added with the social systems. */
function seenAgents(s: WorldState, a: AgentState): { list: SeenAgent[]; others: number } {
  const ids = s.roomAgents.get(a.room);
  const list: SeenAgent[] = [];
  let total = 0;
  if (ids) {
    for (const id of ids) {
      if (id === a.id) continue;
      total++;
      if (list.length >= MAX_AGENTS_LISTED) continue;
      const b = s.agents.get(id)!;
      list.push({
        name: b.name,
        class: b.cls,
        lvl: b.level,
        ...(b.title ? { title: b.title } : {}),
        appearance: b.appearance,
        lookHash: b.lookHash,
        ...(b.fallen ? { fallen: true as const } : {}),
      });
    }
  }
  return { list, others: total - list.length };
}

/** Actions that make sense where the agent stands right now (PLANEJAMENTO §11.3). */
function contextActions(run: Run, a: AgentState, o: Observation['room']): ActionName[] {
  if (a.fallen) return ['release', 'say', 'whisper'];
  const c = run.c;
  const out: ActionName[] = [];
  const room = c.rooms.get(a.room)!;
  if (a.combat) out.push('attack', 'cast', 'flee', 'use');
  else {
    out.push('move');
    if (o.monsters.length) out.push('attack', 'cast');
    if (room.resources.length) out.push('gather');
    if (o.npcs.length) out.push('talk');
    if (o.npcs.some((n) => n.roles.includes('shop'))) out.push('shop_buy', 'shop_sell');
    if (o.npcs.some((n) => n.roles.includes('quest'))) out.push('quest_accept', 'quest_turn_in');
    if (room.flags.includes('tavern')) out.push('rest');
    if (room.stations.length && a.profession) out.push('craft');
    if (a.level >= 5 && !a.profession) out.push('choose_profession');
    if (o.items) out.push('take');
  }
  out.push('say', 'emote', 'whisper', 'inventory', 'quest_list');
  return out;
}

/**
 * What an agent perceives: itself and its room, compact enough for an LLM to read cheaply.
 * Pure read apart from bringing lazy regeneration up to date.
 */
export function observe(s: WorldState, agentId: string, ctx: { now: number; rng: Rng }): Observation {
  const a = s.agents.get(agentId);
  if (!a) throw new Error(`unknown agent ${agentId}`);
  const run = newRun(s, ctx.now, ctx.rng, a);
  touch(run, a, false);
  const c = s.content;
  const d = derive(c, a, ctx.now);
  const def = c.rooms.get(a.room)!;
  const st = s.rooms.get(a.room)!;

  const monsters: Observation['room']['monsters'] = [];
  for (const m of st.monsters) {
    refreshMonster(s, m, ctx.now);
    const kind = c.monsters.get(m.kind)!;
    let row = monsters.find((x) => x.id === m.kind);
    if (!row) monsters.push((row = { id: m.kind, n: 0, lvl: kind.level }));
    row.n++;
    // Show the health of the one the agent is fighting, or of any wounded one.
    if (m.uid === a.combat?.mon || (m.hp < kind.hp && !row.hp)) row.hp = [m.hp, kind.hp];
  }

  const resources: Record<string, number> = {};
  for (const r of def.resources) resources[r.id] = refreshResource(s, a.room, r.id, ctx.now)?.qty ?? 0;

  const seen = seenAgents(s, a);
  const room: Observation['room'] = {
    id: a.room,
    zone: def.zone,
    flags: def.flags,
    exits: def.exits,
    agents: seen.list,
    ...(seen.others > 0 ? { others: seen.others } : {}),
    npcs: (c.npcsByRoom.get(a.room) ?? []).map((n) => ({ id: n.id, roles: n.roles })),
    monsters,
    ...(Object.keys(st.ground).length ? { items: { ...st.ground } } : {}),
    ...(def.resources.length ? { resources } : {}),
    ...(def.stations.length ? { stations: def.stations } : {}),
  };
  const locked = Object.entries(def.gates).map(([dir, g]) => [dir, g.requires] as const);
  if (locked.length) room.locked = Object.fromEntries(locked);

  const obs: Observation = {
    you: {
      name: a.name,
      lvl: a.level,
      hp: [shownHp(a), d.maxHp],
      mp: [Math.floor(a.mp), d.maxMp],
      ap: [a.ap, BALANCE.ap.max],
      gold: a.gold,
      xp: [a.xp, xpToNext(a.level)],
      ...(a.fallen ? { fallen: Math.max(0, Math.ceil((a.fallen.until - ctx.now) / 1000)) } : {}),
      ...(a.combat ? { in_combat: st.monsters.find((m) => m.uid === a.combat!.mon)?.kind ?? 'unknown' } : {}),
      ...(a.title ? { title: a.title } : {}),
      bag: [slotsUsed(c, a.inv), capacity(c, a)],
    },
    room,
    time: dayPhase(ctx.now),
    actions: [],
  };
  obs.actions = contextActions(run, a, room);

  const next = nextTutorial(run, a);
  if (next) {
    const active = a.quests[next.id];
    obs.quest_hint = {
      id: next.id,
      giver: next.giver,
      room: c.npcs.get(next.giver)!.room,
      state: active ? (questReady(a, next) ? 'ready' : 'active') : 'offer',
    };
  }
  return obs;
}

/** Inbox events newer than the cursor, plus the cursor to use next time. */
export function eventsSince(s: WorldState, agentId: string, cursor: number, limit = 50): { events: GameEvent[]; cursor: number } {
  const events = inboxSince(s, agentId, cursor, limit);
  const last = events[events.length - 1];
  // A full page may have more behind it: continue from its last event. Otherwise the agent is up to date.
  return { events, cursor: events.length >= limit && last ? Number(last.id) : s.meta.eventSeq };
}
