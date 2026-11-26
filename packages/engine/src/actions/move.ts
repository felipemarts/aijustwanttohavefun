import { ref } from '@ajwf/shared';
import { statMax } from '../agent';
import { gateBlocker } from '../gates';
import { questEvent } from '../quests';
import { emit, fail, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { relocate } from '../world';
import type { HandlerMap } from './util';

const DIR_ALIASES: Record<string, string> = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };

/** Puts the agent in a room, with the bookkeeping every arrival needs. */
export function enterRoom(run: Run, a: AgentState, to: string, dir?: string): void {
  const from = a.room;
  relocate(run.s, a, to, run.now);
  if (!a.visited.includes(to)) {
    a.visited.push(to);
    statMax(run, a, 'rooms_visited', a.visited.length);
  }
  emit(run, 'move', {
    room: to,
    actor: a.id,
    m: msg('ev.move', { actor: a.name, room: ref.room(to) }),
    data: { from, to, ...(dir ? { dir } : {}) },
  });
  questEvent(run, a, 'visit', to);
}

export const moveActions: HandlerMap = {
  move(run, a, p) {
    const room = run.c.rooms.get(a.room)!;
    const raw = p.dir.trim().toLowerCase();
    // Accept a direction, a short alias or the id of an adjacent room.
    const dir = room.exits[raw] ? raw : (DIR_ALIASES[raw] ?? Object.keys(room.exits).find((d) => room.exits[d] === raw) ?? raw);
    const to = room.exits[dir];
    if (!to) fail('TARGET_NOT_FOUND', 'no_exit', { dir: p.dir, exits: Object.keys(room.exits).join(', ') });
    const gate = room.gates[dir];
    if (gate) {
      const block = gateBlocker(run, a, gate);
      if (block) fail(block.code, block.slug, block.params);
    }
    enterRoom(run, a, to, dir);
    tell(run, 'n.move', { dir: ref.dir(dir), room: ref.room(to) });
    tell(run, `content.room.${to}.desc`);
  },
};
