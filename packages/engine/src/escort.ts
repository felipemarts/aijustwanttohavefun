import type { Quest } from '@ajwf/content';
import { hasOwnKey, ref } from '@ajwf/shared';
import { BALANCE } from './balance';
import { partyHere } from './party';
import { questEvent } from './quests';
import { emit, fail, markAgent, msg, tell, type Run } from './run';
import type { AgentState, Escort, WorldState } from './types';

/**
 * Escort quests (§6.3): a slow NPC walks with a party. It steps into the next room as soon as two of its guards
 * (party members) stand there, loses health to every monster alive where it arrives (less with a Warrior around),
 * and gives up when left waiting too long.
 */

export function markEscorts(s: WorldState): void {
  s.dirty.add('escorts');
}

/** Adds an escort to the derived indexes (party and room). */
export function indexEscort(s: WorldState, e: Escort): void {
  s.escortOfParty.set(e.party, e.id);
  let here = s.escortsIn.get(e.room);
  if (!here) s.escortsIn.set(e.room, (here = new Set()));
  here.add(e.id);
}

function unindexEscort(s: WorldState, e: Escort): void {
  if (s.escortOfParty.get(e.party) === e.id) s.escortOfParty.delete(e.party);
  s.escortsIn.get(e.room)?.delete(e.id);
}

export function escortOfParty(s: WorldState, partyId: string | null): Escort | undefined {
  const id = partyId ? s.escortOfParty.get(partyId) : undefined;
  return id ? s.escorts.get(id) : undefined;
}

function guardsNeeded(q: Quest): number {
  return Math.max(q.party_min, BALANCE.escort.guards);
}

/** Checks, before anything changes, that the agent may take this escort quest now. */
export function escortCheck(run: Run, a: AgentState, q: Quest): void {
  if (q.kind !== 'escort' || !q.escort) return;
  const need = guardsNeeded(q);
  if (!a.party || partyHere(run, a).length < need) fail('PARTY_REQUIRED', 'escort_party', { n: need });
  const busy = escortOfParty(run.s, a.party);
  if (busy && busy.quest !== q.id) fail('CONFLICT', 'escort_busy', { npc: ref.npc(busy.npc) });
}

function stallTimer(s: WorldState, e: Escort): void {
  s.timers.push({ at: e.at + BALANCE.escort.stallMs, kind: 'escort', id: e.id });
}

/** After the quest is accepted: the party's escort starts, or the agent joins the one already under way. */
export function escortJoin(run: Run, a: AgentState, q: Quest): void {
  if (q.kind !== 'escort' || !q.escort || !a.party) return;
  const s = run.s;
  const npc = ref.npc(q.escort.npc);
  const dest = ref.room(q.escort.to);
  const cur = escortOfParty(s, a.party);
  if (cur) {
    if (!cur.guards.includes(a.id)) cur.guards.push(a.id);
    markEscorts(s);
    tell(run, 'n.escort_joined', { npc, room: dest });
    return;
  }
  const B = BALANCE.escort;
  const e: Escort = { id: `e${(++s.meta.escortSeq).toString(36)}`, quest: q.id, npc: q.escort.npc, to: q.escort.to, party: a.party, room: a.room, hp: B.hp, max: B.hp, guards: [a.id], at: run.now };
  s.escorts.set(e.id, e);
  indexEscort(s, e);
  stallTimer(s, e);
  s.dirty.add('meta');
  markEscorts(s);
  tell(run, 'n.escort_start', { npc, room: dest, n: guardsNeeded(q) });
  const party = s.parties.get(a.party)!;
  emit(run, 'escort_start', { room: a.room, actor: a.id, to: party.members, m: msg('ev.escort_start', { actor: a.name, npc, room: dest }), data: { npc: e.npc, to: e.to } });
}

function remove(s: WorldState, e: Escort): void {
  unindexEscort(s, e);
  s.escorts.delete(e.id);
  markEscorts(s);
}

/** Everyone who may hold the quest: the guards and the party's current members. */
function holders(s: WorldState, e: Escort): AgentState[] {
  const ids = new Set(e.guards);
  for (const id of s.parties.get(e.party)?.members ?? []) ids.add(id);
  const out: AgentState[] = [];
  for (const id of ids) {
    const b = s.agents.get(id);
    if (b && hasOwnKey(b.quests, e.quest)) out.push(b);
  }
  return out;
}

/** The escort is over without success: the guards lose the quest (they may take it again). */
export function failEscort(run: Run, e: Escort, why: 'fell' | 'stalled'): void {
  const s = run.s;
  const losers = holders(s, e);
  for (const b of losers) {
    delete b.quests[e.quest];
    markAgent(s, b);
  }
  remove(s, e);
  const p = { npc: ref.npc(e.npc), room: ref.room(e.to) };
  const to = losers.map((b) => b.id);
  if (why === 'fell') {
    if (run.actor && losers.includes(run.actor)) tell(run, 'n.escort_failed', p);
    emit(run, 'escort_failed', { room: e.room, vis: 'public', to, drama: 5, m: msg('ev.escort_failed', p), data: { npc: e.npc, quest: e.quest } });
  } else {
    emit(run, 'escort_lost', { room: e.room, vis: 'private', to, m: msg('ev.escort_lost', p), data: { npc: e.npc, quest: e.quest } });
  }
}

/** A guard has just walked into a room: the NPC follows when enough guards stand there, next to where it waits. */
export function escortAfterMove(run: Run, a: AgentState): void {
  const s = run.s;
  const e = escortOfParty(s, a.party);
  if (!e || e.party !== a.party || e.room === a.room) return;
  const to = a.room;
  const exits = run.c.rooms.get(e.room)?.exits;
  if (!exits || !Object.values(exits).includes(to)) return;
  const q = run.c.quests.get(e.quest);
  const party = s.parties.get(e.party);
  if (!q || !party) return;
  const guards: AgentState[] = [];
  for (const id of party.members) {
    const b = s.agents.get(id);
    if (b && b.room === to && !b.fallen) guards.push(b);
  }
  if (guards.length < guardsNeeded(q)) return;

  const B = BALANCE.escort;
  s.escortsIn.get(e.room)?.delete(e.id);
  e.room = to;
  e.at = run.now;
  indexEscort(s, e);
  stallTimer(s, e);
  markEscorts(s);
  const monsters = s.rooms.get(to)?.monsters.length ?? 0;
  const shield = guards.some((b) => b.cls === 'warrior') ? B.warriorFactor : 1;
  const dmg = Math.min(e.hp, Math.round(monsters * B.dmgPerMonster * shield));
  e.hp -= dmg;
  const npc = ref.npc(e.npc);
  if (e.hp <= 0) {
    failEscort(run, e, 'fell');
    return;
  }
  const p = { npc, room: ref.room(to), hp: e.hp, max: e.max, dmg };
  const key = dmg > 0 ? 'hurt' : 'step';
  tell(run, dmg > 0 ? 'n.escort_hurt' : 'n.escort_step', p);
  emit(run, `escort_${key}`, { room: to, to: party.members, m: msg(dmg > 0 ? 'ev.escort_hurt' : 'ev.escort_step', p), data: { npc: e.npc, hp: e.hp } });
  if (to !== e.to) return;

  remove(s, e);
  const names = guards.map((b) => b.name).join(', ');
  tell(run, 'n.escort_done', { npc, room: ref.room(to) });
  emit(run, 'escort_done', { room: to, actor: a.id, vis: 'public', to: party.members, drama: 4, m: msg('ev.escort_done', { npc, room: ref.room(to), names }), data: { npc: e.npc, quest: e.quest } });
  for (const b of guards) if (hasOwnKey(b.quests, e.quest)) questEvent(run, b, 'escort', to);
}

/** Stall check: an escort whose NPC has not moved for too long ends. */
export function escortTimer(run: Run, id: string): void {
  const e = run.s.escorts.get(id);
  if (e && e.at + BALANCE.escort.stallMs <= run.now) failEscort(run, e, 'stalled');
}

export type EscortView = { npc: string; hp: [number, number]; to: string };

/** Escorted NPCs standing in a room, for `observe`. */
export function escortsHere(s: WorldState, roomId: string): EscortView[] {
  const out: EscortView[] = [];
  for (const id of s.escortsIn.get(roomId) ?? []) {
    const e = s.escorts.get(id);
    if (e) out.push({ npc: e.npc, hp: [e.hp, e.max], to: e.to });
  }
  return out;
}
