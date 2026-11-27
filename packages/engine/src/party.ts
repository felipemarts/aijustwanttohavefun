import { own } from '@ajwf/shared';
import { BALANCE } from './balance';
import { isBestFriend, raiseBond } from './bond';
import type { Run } from './run';
import type { AgentState, Party, WorldState } from './types';

export function partyOf(s: WorldState, a: AgentState): Party | undefined {
  return a.party ? s.parties.get(a.party) : undefined;
}

export function markParty(s: WorldState, p: Party): void {
  s.dirty.add(`party:${p.id}`);
}

/** The agent plus the members of its party standing in the same room and able to act. */
export function partyHere(run: Run, a: AgentState): AgentState[] {
  const p = partyOf(run.s, a);
  const out = [a];
  if (!p) return out;
  for (const id of p.members) {
    if (id === a.id) continue;
    const b = run.s.agents.get(id);
    if (b && b.room === a.room && !b.fallen) out.push(b);
  }
  return out;
}

/** A Best Friend from the agent's party stands with it in the room. */
export function bestFriendAtSide(run: Run, a: AgentState): boolean {
  if (!a.party) return false;
  return partyHere(run, a).some((b) => b !== a && isBestFriend(a, b));
}

export function createParty(run: Run, leader: AgentState): Party {
  const s = run.s;
  const p: Party = { id: `p${(++s.meta.partySeq).toString(36)}`, leader: leader.id, members: [leader.id], loot: 'round_robin', rr: 0, joined: { [leader.id]: run.now } };
  s.parties.set(p.id, p);
  leader.party = p.id;
  s.dirty.add('meta');
  markParty(s, p);
  return p;
}

export function addMember(run: Run, p: Party, b: AgentState): void {
  p.members.push(b.id);
  p.joined[b.id] = run.now;
  b.party = p.id;
  markParty(run.s, p);
}

/** Time spent together in the party becomes bond, credited when the pair splits. */
export function partyTimeBonds(run: Run, p: Party, a: AgentState): void {
  const B = BALANCE.bond;
  for (const id of p.members) {
    const b = run.s.agents.get(id);
    if (!b || b === a) continue;
    const since = Math.max(own(p.joined, a.id) ?? run.now, own(p.joined, id) ?? run.now);
    raiseBond(run, a, b, Math.min(B.partyMax, Math.floor(((run.now - since) / 3_600_000) * B.partyPerHour)));
  }
}

export type Departure = { leader: string | null; dissolved: string | null };

/**
 * Takes an agent out of its party: leadership passes to the earliest joiner, and a party left with a single member
 * dissolves. Pure state change, so it also serves retirement and bans. Returns the new leader (when it changed) and
 * the member left alone (when the party dissolved).
 */
export function removeMember(s: WorldState, a: AgentState): Departure {
  const p = partyOf(s, a);
  a.party = null;
  const out: Departure = { leader: null, dissolved: null };
  if (!p) return out;
  p.members = p.members.filter((id) => id !== a.id);
  delete p.joined[a.id];
  if (p.leader === a.id && p.members.length) {
    p.leader = p.members[0]!;
    out.leader = p.leader;
  }
  if (p.members.length <= 1) {
    const last = p.members[0] && s.agents.get(p.members[0]);
    if (last) {
      last.party = null;
      s.dirty.add(`agent:${last.id}`);
      out.dissolved = last.id;
    }
    s.parties.delete(p.id);
  }
  markParty(s, p);
  return out;
}
