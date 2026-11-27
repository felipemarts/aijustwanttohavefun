import { own } from '@ajwf/shared';
import { bump, touch } from '../agent';
import { BALANCE } from '../balance';
import { fightDuel } from '../duel';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { unlockedAt } from '../unlocks';
import { agentHere, hasFlag, type HandlerMap } from './util';

/** Duels happen only where fighting is a sport, between two agents who are standing and not busy with a monster. */
function duelOpponent(run: Run, a: AgentState, name: string): AgentState {
  if (!hasFlag(run, a, 'training') && !hasFlag(run, a, 'arena') && !unlockedAt(run.s, 'arena_duels', a.room)) fail('NOT_AVAILABLE_HERE', 'duel_place');
  const b = agentHere(run, a, name);
  if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
  if (b.fallen) fail('NOT_ALLOWED', 'duel_fallen', { name: b.name });
  if (b.combat && b.combat.until > run.now) fail('IN_COMBAT', 'duel_busy', { name: b.name });
  return b;
}

export const duelActions: HandlerMap = {
  duel_invite(run, a, p) {
    const b = duelOpponent(run, a, p.agent);
    const live = Object.entries(b.duelInvites).filter(([, until]) => until > run.now);
    if (!live.some(([id]) => id === a.id) && live.length >= BALANCE.duel.maxInvites) fail('CONFLICT', 'duel_invites_full', { name: b.name });
    b.duelInvites = { ...Object.fromEntries(live), [a.id]: run.now + BALANCE.duel.inviteMs };
    markAgent(run.s, b);
    const minutes = BALANCE.duel.inviteMs / 60_000;
    tell(run, 'n.duel_invite', { name: b.name, minutes });
    emit(run, 'duel_invite', { room: a.room, actor: a.id, target: b.id, to: [b.id], m: msg('ev.duel_invite', { actor: a.name, minutes }) });
  },

  duel_accept(run, a, p) {
    const b = duelOpponent(run, a, p.agent);
    if (!((own(a.duelInvites, b.id) ?? 0) > run.now)) fail('TARGET_NOT_FOUND', 'no_duel_invite', { name: b.name });
    touch(run, b);
    delete a.duelInvites[b.id];
    const out = fightDuel(run, b, a);
    // Nobody falls in a duel: the loser is left standing on 1 HP, the winner keeps the wounds it took.
    out.winner.hp = Math.max(1, out.winnerHp);
    out.loser.hp = 1;
    out.winner.regenAt = out.loser.regenAt = run.now;
    markAgent(run.s, b);
    const upset = out.winner.level + BALANCE.duel.upsetGap <= out.loser.level;
    bump(run, out.winner, 'duels_won');
    questEvent(run, a, 'duel');
    questEvent(run, b, 'duel');
    tell(run, out.winner === a ? 'n.duel_won' : 'n.duel_lost', { name: b.name, rounds: out.rounds });
    emit(run, 'duel', {
      room: a.room,
      actor: out.winner.id,
      target: out.loser.id,
      vis: 'public',
      to: 'room',
      drama: upset ? 6 : 3,
      m: msg(upset ? 'ev.duel_upset' : 'ev.duel', { actor: out.winner.name, name: out.loser.name, rounds: out.rounds }),
      data: { winner: out.winner.name, loser: out.loser.name, rounds: out.rounds, upset },
    });
  },
};
