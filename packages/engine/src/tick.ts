import type { GameEvent, Rng } from '@ajwf/shared';
import { wakeAtTemple } from './agent';
import { escortTimer } from './escort';
import { puzzleTimer } from './puzzles';
import { emit, newRun } from './run';
import { electionTick } from './election';
import { closeTrade } from './trade';
import { bountyTimer, wantedTimer } from './trust';
import type { WorldState } from './types';
import { phaseChange, spawnMonster } from './world';
import { worldBossTimer } from './worldboss';

/**
 * Advances the world clock: runs every timer that is due (respawns, agents waking at the temple, nightfall, stale
 * trade offers, puzzles closing, the world boss schedule, stalled escorts).
 * Cost is proportional to the number of due timers, never to the size of the world.
 */
export function tick(s: WorldState, ctx: { now: number; rng: Rng }): GameEvent[] {
  const run = newRun(s, ctx.now, ctx.rng);
  for (let t = s.timers.popDue(ctx.now); t; t = s.timers.popDue(ctx.now)) {
    switch (t.kind) {
      case 'respawn': {
        const pending = s.respawns.get(t.room);
        if (pending?.get(t.slot) === t.at) pending.delete(t.slot);
        const m = spawnMonster(s, t.room, t.slot, ctx.now);
        if (m) emit(run, 'spawn', { room: t.room, target: m.uid, data: { mon: m.kind } });
        break;
      }
      case 'fallen': {
        const a = s.agents.get(t.agent);
        if (a?.fallen && a.fallen.until <= ctx.now) wakeAtTemple(run, a);
        break;
      }
      case 'trade':
        // Expired offers are already refused on access; this only clears them out of the state.
        if ((s.trades.get(t.id)?.expires ?? Infinity) <= ctx.now) closeTrade(s, t.id);
        break;
      case 'phase':
        phaseChange(run);
        break;
      case 'puzzle':
        puzzleTimer(run, t.id);
        break;
      case 'wboss':
        worldBossTimer(run, t.step);
        break;
      case 'escort':
        escortTimer(run, t.id);
        break;
      case 'election':
        electionTick(run);
        break;
      case 'wanted':
        wantedTimer(run, t.agent, t.at);
        break;
      case 'bounty':
        bountyTimer(run, t.target, t.at);
        break;
    }
  }
  return run.events;
}
