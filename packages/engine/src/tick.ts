import type { GameEvent, Rng } from '@ajwf/shared';
import { wakeAtTemple } from './agent';
import { emit, newRun } from './run';
import type { WorldState } from './types';
import { phaseChange, spawnMonster } from './world';

/**
 * Advances the world clock: runs every timer that is due (respawns, agents waking at the temple, nightfall).
 * Cost is proportional to the number of due timers, never to the size of the world.
 */
export function tick(s: WorldState, ctx: { now: number; rng: Rng }): GameEvent[] {
  const run = newRun(s, ctx.now, ctx.rng);
  let popped = false;
  for (let t = s.timers.popDue(ctx.now); t; t = s.timers.popDue(ctx.now)) {
    popped = true;
    switch (t.kind) {
      case 'respawn': {
        const m = spawnMonster(s, t.room, t.slot, ctx.now);
        if (m) emit(run, 'spawn', { room: t.room, target: m.uid, data: { mon: m.kind } });
        break;
      }
      case 'fallen': {
        const a = s.agents.get(t.agent);
        if (a?.fallen && a.fallen.until <= ctx.now) wakeAtTemple(run, a);
        break;
      }
      case 'phase':
        phaseChange(run);
        break;
    }
  }
  if (popped) s.dirty.add('timers');
  return run.events;
}
