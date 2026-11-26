import type { Appearance } from '@ajwf/appearance';
import type { ActionName, GameEvent, LootMode } from '@ajwf/shared';
import { capacity, derive, shownHp, slotsUsed, touch } from './agent';
import { BALANCE, dayPhase, realDay, xpToNext } from './balance';
import { bondLevel, bondScore, type BondLevel } from './bond';
import { escortsHere, type EscortView } from './escort';
import { gateBlocker } from './gates';
import { goodsView } from './goods';
import { canManage, guildOf } from './guild';
import { partyOf } from './party';
import { PUZZLE_CLASS, puzzleViews, type PuzzleView } from './puzzles';
import { routeHint } from './routes';
import { nextTutorial, questReady } from './quests';
import { inboxSince, newRun, type Run } from './run';
import { tradesOf } from './trade';
import type { AgentState, WorldState } from './types';
import { refreshMonster, refreshResource } from './world';
import { worldBossInfo } from './worldboss';
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
  /** Shown from Acquaintance up. */
  bond?: BondLevel;
  /** How the observer relates to this agent, when it does: party, friend, guild, rival. */
  rel?: Relation;
};

type Relation = 'party' | 'friend' | 'guild' | 'rival';

/** Things addressed to the agent that wait for an answer. Each list only appears when non-empty. */
export type Pending = {
  /** Names of agents asking for friendship (friend_accept). */
  friends?: string[];
  /** Names of inviters (party_accept). */
  party?: string[];
  /** Guild names (guild_join). */
  guild?: string[];
  /** Names of challengers (duel_accept). */
  duel?: string[];
  /** Trade offers to answer with trade_accept or trade_cancel. */
  trades?: { id: string; from: string; give: ReturnType<typeof goodsView>; want: ReturnType<typeof goodsView> }[];
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
    party?: { leader: string; members: string[]; loot: LootMode };
    guild?: string;
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
    /** Dungeon puzzles here: the action that works each one and its live state. */
    puzzles?: PuzzleView[];
    /** Escorted NPCs standing here. */
    escorts?: EscortView[];
  };
  time: string;
  actions: ActionName[];
  pending?: Pending;
  /** A nudge for agents with nothing to do: the next tutorial quest, and the first moves to its giver. */
  quest_hint?: { id: string; giver: string; room: string; state: 'offer' | 'active' | 'ready'; path?: string[] };
  /** The world boss, within the game day (2 h) before it rises: minutes until it rises, or that it is up now. */
  world_boss?: { id: string; room: string; in?: number; up?: true };
};

const RANK: Record<Relation, number> = { party: 0, friend: 1, guild: 2, rival: 3 };

/** Other agents in the room, most relevant first: party, friends, guild mates, rivals, then everyone else. */
function seenAgents(s: WorldState, a: AgentState): { list: SeenAgent[]; others: number } {
  const ids = s.roomAgents.get(a.room);
  const friends = new Set(a.friends);
  const rivals = new Set(a.rivals);
  const relOf = (b: AgentState): Relation | undefined => {
    if (a.party && b.party === a.party) return 'party';
    if (friends.has(b.id)) return 'friend';
    if (a.guild && b.guild === a.guild) return 'guild';
    if (rivals.has(b.id)) return 'rival';
    return undefined;
  };
  // Buckets by relevance, filled in one pass; strangers stop being collected once the list is full.
  const buckets: AgentState[][] = [[], [], [], [], []];
  let total = 0;
  let strangers = 0;
  for (const id of ids ?? []) {
    if (id === a.id) continue;
    total++;
    const b = s.agents.get(id)!;
    const rel = relOf(b);
    if (rel) buckets[RANK[rel]]!.push(b);
    else if (strangers++ < MAX_AGENTS_LISTED) buckets[4]!.push(b);
  }
  const list = buckets
    .flat()
    .slice(0, MAX_AGENTS_LISTED)
    .map((b): SeenAgent => {
      const rel = relOf(b);
      const bond = bondLevel(bondScore(a, b));
      return {
        name: b.name,
        class: b.cls,
        lvl: b.level,
        ...(b.title ? { title: b.title } : {}),
        appearance: b.appearance,
        lookHash: b.lookHash,
        ...(b.fallen ? { fallen: true as const } : {}),
        ...(bond ? { bond } : {}),
        ...(rel ? { rel } : {}),
      };
    });
  return { list, others: total - list.length };
}

/** Requests and offers waiting for this agent's answer; undefined when there are none. */
function pendingFor(s: WorldState, a: AgentState, now: number): Pending | undefined {
  // Requests from agents who retired or were banned since cannot be answered any more: leave them out.
  const name = (id: string) => {
    const b = s.agents.get(id);
    return b?.status === 'active' ? b.name : undefined;
  };
  const live = (inv: Record<string, number>) => Object.keys(inv).filter((id) => inv[id]! > now);
  const names = (ids: string[]) => ids.map(name).filter((n): n is string => !!n);
  const out: Pending = {};
  const friends = names(Object.keys(a.friendReqs));
  if (friends.length) out.friends = friends;
  const party = names(live(a.partyInvites));
  if (party.length) out.party = party;
  const guild = live(a.guildInvites)
    .map((id) => s.guilds.get(id)?.name)
    .filter((n): n is string => !!n);
  if (guild.length) out.guild = guild;
  const duel = names(live(a.duelInvites));
  if (duel.length) out.duel = duel;
  const trades = tradesOf(s, a.id, now)
    .filter((t) => t.to === a.id)
    .map((t) => ({ id: t.id, from: name(t.from) ?? '?', give: goodsView(t.give), want: goodsView(t.want) }));
  if (trades.length) out.trades = trades;
  return Object.keys(out).length ? out : undefined;
}

/** Actions that make sense where the agent stands right now (PLANEJAMENTO §11.3). */
function contextActions(run: Run, a: AgentState, o: Observation['room'], pending: Pending | undefined): ActionName[] {
  if (a.fallen) return ['release', 'say', 'whisper'];
  const c = run.c;
  const out: ActionName[] = [];
  const room = c.rooms.get(a.room)!;
  const flags = room.flags;
  if (a.combat) out.push('attack', 'cast', 'flee', 'use');
  else {
    out.push('move');
    if (o.monsters.length) out.push('attack', 'cast');
    if (room.resources.length) out.push('gather');
    if (o.npcs.length) out.push('talk');
    if (o.npcs.some((n) => n.roles.includes('shop'))) out.push('shop_buy', 'shop_sell');
    if (o.npcs.some((n) => n.roles.includes('quest'))) out.push('quest_accept', 'quest_turn_in');
    if (flags.includes('tavern')) out.push('rest');
    if (room.stations.length && a.profession) out.push('craft');
    if (a.level >= 5 && !a.profession) out.push('choose_profession');
    if (o.items) out.push('take');
    if (flags.includes('market')) out.push('market_list', 'market_buy', 'market_sell');
    if (o.agents.length && (flags.includes('training') || flags.includes('arena'))) out.push('duel_invite');
    if (flags.includes('guild_hall') && !a.guild) out.push('guild_create');
    for (const pz of o.puzzles ?? []) {
      const cls = PUZZLE_CLASS[c.puzzles.get(pz.id)!.type];
      const mine = pz.do === 'pull_lever' || !cls || cls === a.cls;
      if (mine && !out.includes(pz.do)) out.push(pz.do);
    }
    if (a.cls === 'rogue') out.push('scout');
    if (a.cls === 'mage' && (a.inv[BALANCE.enchant.item] ?? 0) > 0) out.push('enchant');
  }
  if (o.agents.length) out.push('trade_offer', 'party_invite');
  if (flags.includes('board')) out.push('board_read', 'board_post');
  if (pending?.friends) out.push('friend_accept');
  if (pending?.party) out.push('party_accept');
  if (pending?.guild) out.push('guild_join');
  if (pending?.duel && !a.combat) out.push('duel_accept');
  if (pending?.trades) out.push('trade_accept');
  if (a.party) out.push('party_say');
  if (a.guild) {
    const g = run.s.guilds.get(a.guild);
    if (g && o.agents.length && canManage(g, a)) out.push('guild_invite');
    out.push('guild_say');
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
  // Only exits that are closed right now, for this agent.
  const locked = Object.entries(def.gates).filter(([, g]) => gateBlocker(run, a, g));
  if (locked.length) room.locked = Object.fromEntries(locked.map(([dir, g]) => [dir, g.requires]));
  const puzzles = puzzleViews(s, a.room, ctx.now);
  if (puzzles.length) room.puzzles = puzzles;
  const escorts = escortsHere(s, a.room);
  if (escorts.length) room.escorts = escorts;

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
  const party = partyOf(s, a);
  if (party) {
    const name = (id: string) => s.agents.get(id)?.name ?? '?';
    obs.you.party = { leader: name(party.leader), members: party.members.filter((id) => id !== a.id).map(name), loot: party.loot };
  }
  const guild = guildOf(s, a);
  if (guild) obs.you.guild = guild.name;
  const pending = pendingFor(s, a, ctx.now);
  if (pending) obs.pending = pending;
  obs.actions = contextActions(run, a, room, pending);

  const next = nextTutorial(run, a);
  if (next) {
    const active = a.quests[next.id];
    const giverRoom = c.npcs.get(next.giver)!.room;
    const state = active ? (questReady(a, next) ? 'ready' : 'active') : 'offer';
    // The way to the giver, when there is something to do there (taking or handing in the quest).
    const path = state === 'active' ? undefined : routeHint(c, a.room, giverRoom);
    obs.quest_hint = { id: next.id, giver: next.giver, room: giverRoom, state, ...(path ? { path } : {}) };
  }
  const wb = worldBossInfo(s);
  if (wb?.up) obs.world_boss = { id: wb.monster, room: wb.room, up: true };
  else if (wb && realDay(wb.at) === realDay(ctx.now) && wb.at - ctx.now <= BALANCE.day.lengthMs) obs.world_boss = { id: wb.monster, room: wb.room, in: Math.max(1, Math.ceil((wb.at - ctx.now) / 60_000)) };
  return obs;
}

/** Inbox events newer than the cursor, plus the cursor to use next time. */
export function eventsSince(s: WorldState, agentId: string, cursor: number, limit = 50): { events: GameEvent[]; cursor: number } {
  const events = inboxSince(s, agentId, cursor, limit);
  const last = events[events.length - 1];
  // A full page may have more behind it: continue from its last event. Otherwise the agent is up to date.
  return { events, cursor: events.length >= limit && last ? Number(last.id) : s.meta.eventSeq };
}
