import { LOOT_MODES, MAX_SAY_LEN, own, ref } from '@ajwf/shared';
import { addItem, canFit, removeItem } from '../agent';
import { BALANCE } from '../balance';
import { addMember, createParty, markParty, partyOf, partyTimeBonds, removeMember, trackInvite, untrackInvite } from '../party';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState, Party } from '../types';
import { chatText, REVEAL_AFTER_MS } from './chat';
import { carried } from './items';
import { agentHere, oneOf, type HandlerMap } from './util';

function myParty(run: Run, a: AgentState): Party {
  const p = partyOf(run.s, a);
  if (!p) fail('PARTY_REQUIRED', 'not_in_party');
  return p;
}

function leaderOf(run: Run, a: AgentState): Party {
  const p = myParty(run, a);
  if (p.leader !== a.id) fail('NOT_ALLOWED', 'party_not_leader', { name: run.s.agents.get(p.leader)?.name ?? '?' });
  return p;
}

/** Live invites (expiry -> still in the future), so expired ones never block or count. */
function liveInvites(inv: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(inv).filter(([, until]) => until > now));
}

export const partyActions: HandlerMap = {
  party_invite(run, a, p) {
    const b = agentHere(run, a, p.agent);
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    const party = partyOf(run.s, a);
    if (party && party.leader !== a.id) fail('NOT_ALLOWED', 'party_not_leader', { name: run.s.agents.get(party.leader)?.name ?? '?' });
    if (b.party) fail('CONFLICT', b.party === a.party ? 'already_party_member' : 'target_in_party', { name: b.name });
    if (party && party.members.length >= BALANCE.party.maxSize) fail('CONFLICT', 'party_full', { max: BALANCE.party.maxSize });
    const invites = liveInvites(b.partyInvites, run.now);
    if (own(invites, a.id) === undefined && Object.keys(invites).length >= BALANCE.party.maxInvites) fail('CONFLICT', 'party_invites_full', { name: b.name });
    if (!party) createParty(run, a);
    const until = run.now + BALANCE.party.inviteMs;
    b.partyInvites = { ...invites, [a.id]: until };
    trackInvite(run.s, b, a, until);
    markAgent(run.s, b);
    const minutes = BALANCE.party.inviteMs / 60_000;
    tell(run, 'n.party_invite', { name: b.name, minutes });
    emit(run, 'party_invite', { room: a.room, actor: a.id, target: b.id, vis: 'private', to: [b.id], m: msg('ev.party_invite', { actor: a.name, minutes }) });
  },

  party_accept(run, a, p) {
    const b = agentHere(run, a, p.agent);
    if (!((own(a.partyInvites, b.id) ?? 0) > run.now)) fail('TARGET_NOT_FOUND', 'no_party_invite', { name: b.name, minutes: BALANCE.party.inviteMs / 60_000 });
    if (a.party) fail('CONFLICT', 'already_in_party');
    const existing = partyOf(run.s, b);
    if (existing && existing.members.length >= BALANCE.party.maxSize) fail('CONFLICT', 'party_full', { max: BALANCE.party.maxSize });
    // The inviter's party may have dissolved meanwhile (it was left alone): start it again around the inviter.
    const party = existing ?? createParty(run, b);
    a.partyInvites = liveInvites(a.partyInvites, run.now);
    delete a.partyInvites[b.id];
    untrackInvite(run.s, a, b);
    addMember(run, party, a);
    const leader = run.s.agents.get(party.leader)!;
    tell(run, 'n.party_joined', { leader: leader.name, n: party.members.length });
    emit(run, 'party_join', { room: a.room, actor: a.id, target: party.id, to: party.members, m: msg('ev.party_join', { actor: a.name, leader: leader.name, n: party.members.length }) });
    questEvent(run, a, 'party');
    // Forming the party counts for the one who called it together as well.
    if (party.members.length === 2) questEvent(run, leader, 'party');
  },

  party_leave(run, a) {
    const party = myParty(run, a);
    partyTimeBonds(run, party, a);
    const res = removeMember(run.s, a);
    tell(run, res.dissolved || !party.members.length ? 'n.party_disbanded' : 'n.party_left');
    if (!party.members.length) return;
    const newLeader = res.leader && !res.dissolved ? run.s.agents.get(res.leader)!.name : '';
    emit(run, 'party_leave', {
      room: a.room,
      actor: a.id,
      target: party.id,
      to: party.members,
      m: msg(res.dissolved ? 'ev.party_disbanded' : newLeader ? 'ev.party_leave_leader' : 'ev.party_leave', { actor: a.name, leader: newLeader }),
      data: { dissolved: !!res.dissolved, ...(newLeader ? { leader: res.leader } : {}) },
    });
  },

  party_loot_mode(run, a, p) {
    const mode = oneOf(p.mode, LOOT_MODES, 'party_loot_mode', 'mode');
    const party = leaderOf(run, a);
    if (party.loot === mode) fail('CONFLICT', 'loot_mode_same', { mode });
    party.loot = mode;
    markParty(run.s, party);
    tell(run, 'n.loot_mode', { mode });
    emit(run, 'party_loot_mode', { room: a.room, actor: a.id, target: party.id, to: party.members, m: msg('ev.loot_mode', { actor: a.name, mode }), data: { mode } });
  },

  party_say(run, a, p) {
    const party = myParty(run, a);
    const text = chatText(run, a, p.text, MAX_SAY_LEN);
    tell(run, 'n.party_say', { n: party.members.length - 1 });
    emit(run, 'party_say', { room: a.room, actor: a.id, target: party.id, vis: 'delayed', revealAt: run.now + REVEAL_AFTER_MS, to: party.members, lang: a.lang, data: { text } });
  },

  party_give_loot(run, a, p) {
    const party = leaderOf(run, a);
    const b = agentHere(run, a, p.agent);
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    if (b.party !== party.id) fail('NOT_ALLOWED', 'not_party_member', { name: b.name });
    const item = carried(run, a, p.item);
    if (item.type === 'quest') fail('NOT_ALLOWED', 'quest_item_bound', { item: ref.item(item.id) });
    if (!canFit(run.c, b, [{ item: item.id, qty: 1 }])) fail('INVENTORY_FULL', 'inventory_full_other', { name: b.name });
    removeItem(a, item.id, 1);
    addItem(b, item.id, 1);
    markAgent(run.s, b);
    tell(run, 'n.party_give_loot', { item: ref.item(item.id), name: b.name });
    emit(run, 'party_give_loot', { room: a.room, actor: a.id, target: b.id, to: party.members, m: msg('ev.party_give_loot', { actor: a.name, item: ref.item(item.id), name: b.name }), data: { item: item.id } });
  },
};
