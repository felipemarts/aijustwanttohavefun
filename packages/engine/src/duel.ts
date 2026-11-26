import { derive } from './agent';
import { BALANCE } from './balance';
import { rollDamage } from './combat';
import type { Run } from './run';
import type { AgentState } from './types';

export type DuelOutcome = { winner: AgentState; loser: AgentState; rounds: number; winnerHp: number };

/**
 * Fights a duel to the first knockdown with the normal damage formula, from the fighters' current HP. The quicker
 * fighter (AGI, the challenger on a tie) strikes first and they alternate; a round is one blow each. Nothing is
 * changed here: the caller applies the outcome.
 */
export function fightDuel(run: Run, challenger: AgentState, other: AgentState): DuelOutcome {
  const dc = derive(run.c, challenger, run.now);
  const doo = derive(run.c, other, run.now);
  const order = doo.agi > dc.agi ? [other, challenger] : [challenger, other];
  const stats = new Map([
    [challenger, dc],
    [other, doo],
  ]);
  const hp = new Map([
    [challenger, challenger.hp],
    [other, other.hp],
  ]);
  const maxBlows = BALANCE.duel.maxRounds * 2;
  let blows = 0;
  for (; blows < maxBlows; blows++) {
    const atk = order[blows % 2]!;
    const def = order[(blows + 1) % 2]!;
    const d = stats.get(atk)!;
    const { dmg } = rollDamage(run, d.atk, 1, stats.get(def)!.def, d.crit);
    hp.set(def, hp.get(def)! - dmg);
    if (hp.get(def)! <= 0) {
      blows++;
      return { winner: atk, loser: def, rounds: Math.ceil(blows / 2), winnerHp: hp.get(atk)! };
    }
  }
  // Nobody went down in time: the one with the larger share of health left wins on points.
  const share = (x: AgentState) => hp.get(x)! / stats.get(x)!.maxHp;
  const [winner, loser] = share(other) > share(challenger) ? [other, challenger] : [challenger, other];
  return { winner, loser, rounds: BALANCE.duel.maxRounds, winnerHp: hp.get(winner)! };
}
