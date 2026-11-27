import { appearanceHash, type Appearance } from '@ajwf/appearance';
import { checkAgentName, maskBlockedWords, MAX_BIO_LEN, sanitizeAgentText, type ClassId, type Rng } from '@ajwf/shared';
import { derive } from './agent';
import { BALANCE } from './balance';
import { removeMember } from './party';
import { emit, inboxRemove, markAgent, msg, newRun } from './run';
import type { ActionError, AgentState, WorldState } from './types';
import type { GameEvent } from '@ajwf/shared';

export type RegisterInput = {
  name: string;
  cls: ClassId;
  lang: string;
  bio?: string;
  appearance: Appearance;
  /** Scripted bots are always labelled as such. */
  bot?: boolean;
  claimed?: boolean;
};

export type RegisterResult = { ok: true; agent: AgentState; events: GameEvent[] } | { ok: false; error: ActionError };

/** Defaults for every field, so snapshots written by older versions load cleanly. */
export function blankAgent(now: number): AgentState {
  return {
    id: '',
    name: '',
    norm: '',
    skeleton: '',
    cls: 'warrior',
    lang: 'en',
    bio: '',
    appearance: {} as Appearance,
    lookHash: '',
    claimed: false,
    bot: false,
    status: 'active',
    mutedUntil: 0,
    ownerNote: '',
    room: BALANCE.startRoom,
    level: 1,
    xp: 0,
    hp: 1,
    mp: 0,
    ap: BALANCE.ap.max,
    regenAt: now,
    apAt: now,
    gold: BALANCE.startGold,
    inv: {},
    equip: { weapon: null, armor: null, trinket: null, bag: null },
    profession: null,
    buffs: [],
    cooldowns: {},
    fallen: null,
    combat: null,
    quests: {},
    questsDone: {},
    stats: {},
    achievements: {},
    titles: [],
    title: null,
    visited: [],
    roomAt: now,
    friends: [],
    rivals: [],
    friendReqs: {},
    bonds: {},
    party: null,
    partyInvites: {},
    guild: null,
    guildInvites: {},
    duelInvites: {},
    journal: { day: 0, n: 0 },
    honor: 0,
    infamy: 0,
    infamyAt: now,
    wanted: null,
    gives: [],
    createdAt: now,
    lastActiveAt: now,
  };
}

/** Is this name free? Checks the exact name and lookalikes ("Pip" vs "P1p"). */
export function nameAvailable(s: WorldState, raw: string): { ok: true; display: string; norm: string; skeleton: string } | { ok: false; code: 'NAME_INVALID' | 'NAME_TAKEN'; reason: string } {
  const check = checkAgentName(raw);
  if (!check.ok) return { ok: false, code: 'NAME_INVALID', reason: check.reason };
  if (s.byName.has(check.norm) || s.bySkeleton.has(check.skeleton)) return { ok: false, code: 'NAME_TAKEN', reason: 'taken' };
  return check;
}

/** Creates an agent in the village square with its class starter kit. The appearance must already be validated. */
export function registerAgent(s: WorldState, input: RegisterInput, ctx: { now: number; rng: Rng }): RegisterResult {
  const name = nameAvailable(s, input.name);
  if (!name.ok) {
    return { ok: false, error: { code: name.code, msg: msg(name.code === 'NAME_TAKEN' ? 'err.name_taken' : `err.name_${name.reason}`, { name: input.name }), hint: msg('hint.name') } };
  }
  const cls = s.content.classes.get(input.cls);
  if (!cls) return { ok: false, error: { code: 'INVALID_PARAMS', msg: msg('err.class_unknown', { class: input.cls }) } };

  const a = blankAgent(ctx.now);
  a.id = `a${(++s.meta.agentSeq).toString(36)}`;
  a.name = name.display;
  a.norm = name.norm;
  a.skeleton = name.skeleton;
  a.cls = input.cls;
  a.lang = input.lang;
  a.bio = input.bio ? maskBlockedWords(sanitizeAgentText(input.bio, MAX_BIO_LEN).text) : '';
  a.appearance = { ...input.appearance };
  a.lookHash = appearanceHash(a.appearance);
  a.bot = input.bot === true;
  a.claimed = input.claimed === true;
  a.visited = [a.room];

  // Starter kit: the weapon goes in hand, the rest in the bag (the tutorial teaches `equip` with the armor).
  for (const st of cls.starter) {
    const item = s.content.items.get(st.item)!;
    if (item.type === 'weapon' && !a.equip.weapon) a.equip.weapon = item.id;
    else a.inv[item.id] = (a.inv[item.id] ?? 0) + st.qty;
  }
  const d = derive(s.content, a, ctx.now);
  a.hp = d.maxHp;
  a.mp = d.maxMp;

  s.agents.set(a.id, a);
  s.byName.set(a.norm, a.id);
  s.bySkeleton.set(a.skeleton, a.id);
  s.lookHashes.set(a.lookHash, (s.lookHashes.get(a.lookHash) ?? 0) + 1);
  s.roomAgents.get(a.room)!.add(a.id);
  markAgent(s, a);
  s.dirty.add('meta');

  const run = newRun(s, ctx.now, ctx.rng);
  emit(run, 'arrival', {
    room: a.room,
    actor: a.id,
    vis: 'public',
    to: 'room',
    drama: 2,
    m: msg('ev.arrival', { actor: a.name, class: `@class:${a.cls}` }),
    data: { class: a.cls, hash: a.lookHash, bot: a.bot },
  });
  return { ok: true, agent: a, events: run.events };
}

const countLook = (s: WorldState, hash: string, by: 1 | -1): void => {
  const n = (s.lookHashes.get(hash) ?? 0) + by;
  if (n <= 0) s.lookHashes.delete(hash);
  else s.lookHashes.set(hash, n);
};

/**
 * Removes an agent from the indexes when it is retired or banned: the room index and the look count (a restored
 * world counts only active agents, so this keeps the live world equal to its snapshot). Its snapshot stays, and so
 * does its name in the name indexes. It also leaves its party, which only makes sense with members who can still
 * act; guild membership, trades and market orders stay (other agents re-check them when they act).
 */
export function deactivateAgent(s: WorldState, agentId: string, status: 'retired' | 'banned'): void {
  const a = s.agents.get(agentId);
  if (!a) return;
  if (a.status === 'active') {
    s.roomAgents.get(a.room)?.delete(a.id);
    countLook(s, a.lookHash, -1);
  }
  a.status = status;
  removeMember(s, a);
  markAgent(s, a);
}

/**
 * Lifts a ban: the agent is active again in the room it was in, back in the indexes `deactivateAgent` took it out
 * of. Its name never stopped being reserved. The party it left is not restored, and a fight it was in is
 * forgotten (as on a restore). Only banned agents come back: retirement is the owner's choice, and unknown or
 * active agents are left alone. Returns whether anything changed.
 */
export function reactivateAgent(s: WorldState, agentId: string): boolean {
  const a = s.agents.get(agentId);
  if (!a || a.status !== 'banned') return false;
  if (!s.roomAgents.has(a.room)) a.room = BALANCE.startRoom;
  a.status = 'active';
  a.combat = null;
  s.roomAgents.get(a.room)!.add(a.id);
  countLook(s, a.lookHash, 1);
  markAgent(s, a);
  return true;
}

/**
 * Undoes a registration that could not be made durable (the server failed to store the agent's key).
 * Only valid right after `registerAgent`, before the agent did anything.
 */
export function unregisterAgent(s: WorldState, agentId: string): void {
  const a = s.agents.get(agentId);
  if (!a) return;
  s.agents.delete(a.id);
  if (s.byName.get(a.norm) === a.id) s.byName.delete(a.norm);
  if (s.bySkeleton.get(a.skeleton) === a.id) s.bySkeleton.delete(a.skeleton);
  if (a.status === 'active') countLook(s, a.lookHash, -1);
  const here = s.roomAgents.get(a.room);
  here?.delete(a.id);
  // Its arrival was announced to everyone in the room: take that back too, so nobody meets a ghost.
  for (const id of here ?? []) inboxRemove(s, id, (ev) => ev.type === 'arrival' && ev.actor === a.id);
  s.inboxes.delete(a.id);
  s.dirty.delete(`agent:${a.id}`);
}
