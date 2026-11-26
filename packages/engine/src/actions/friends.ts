import { statMax } from '../agent';
import { BALANCE } from '../balance';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { agentByName, type HandlerMap } from './util';

/** Any active agent by name, wherever it is, but not the actor itself. */
function someoneElse(run: Run, a: AgentState, name: string): AgentState {
  const b = agentByName(run, name);
  if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name });
  if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
  return b;
}

function befriend(run: Run, a: AgentState, b: AgentState): void {
  const max = BALANCE.social.maxFriends;
  if (a.friends.length >= max) fail('CONFLICT', 'friends_full', { max });
  if (b.friends.length >= max) fail('CONFLICT', 'friends_full_other', { name: b.name, max });
  delete a.friendReqs[b.id];
  delete b.friendReqs[a.id];
  a.friends.push(b.id);
  b.friends.push(a.id);
  for (const x of [a, b]) {
    statMax(run, x, 'friends', x.friends.length);
    questEvent(run, x, 'friend');
    markAgent(run.s, x);
  }
  tell(run, 'n.friend_added', { name: b.name });
  emit(run, 'friend', { room: a.room, actor: a.id, target: b.id, vis: 'public', to: [b.id], drama: 1, m: msg('ev.friend', { actor: a.name, name: b.name }) });
}

export const friendActions: HandlerMap = {
  friend_request(run, a, p) {
    const b = someoneElse(run, a, p.agent);
    if (a.friends.includes(b.id)) fail('CONFLICT', 'already_friends', { name: b.name });
    // Both asked: that is a yes from each side.
    if (a.friendReqs[b.id] !== undefined) return befriend(run, a, b);
    if (b.friendReqs[a.id] !== undefined) fail('CONFLICT', 'friend_request_pending', { name: b.name });
    if (Object.keys(b.friendReqs).length >= BALANCE.social.maxFriendRequests) fail('CONFLICT', 'friend_requests_full', { name: b.name });
    if (a.friends.length >= BALANCE.social.maxFriends) fail('CONFLICT', 'friends_full', { max: BALANCE.social.maxFriends });
    b.friendReqs[a.id] = run.now;
    markAgent(run.s, b);
    tell(run, 'n.friend_request', { name: b.name });
    emit(run, 'friend_request', { room: a.room, actor: a.id, target: b.id, vis: 'private', to: [b.id], m: msg('ev.friend_request', { actor: a.name }) });
  },

  friend_accept(run, a, p) {
    const b = someoneElse(run, a, p.agent);
    if (a.friends.includes(b.id)) fail('CONFLICT', 'already_friends', { name: b.name });
    if (a.friendReqs[b.id] === undefined) fail('TARGET_NOT_FOUND', 'no_friend_request', { name: b.name });
    befriend(run, a, b);
  },

  declare_rival(run, a, p) {
    const b = someoneElse(run, a, p.agent);
    if (a.rivals.includes(b.id)) fail('CONFLICT', 'already_rival', { name: b.name });
    if (a.rivals.length >= BALANCE.social.maxRivals) fail('CONFLICT', 'rivals_full', { max: BALANCE.social.maxRivals });
    a.rivals.push(b.id);
    statMax(run, a, 'rivals', a.rivals.length);
    tell(run, 'n.rival', { name: b.name });
    emit(run, 'rival', { room: a.room, actor: a.id, target: b.id, vis: 'public', to: [b.id], drama: 4, m: msg('ev.rival', { actor: a.name, name: b.name }) });
  },
};
