import type { Room } from '@ajwf/content';
import { ref } from '@ajwf/shared';
import { statMax } from '../agent';
import { escortAfterMove } from '../escort';
import { gateBlocker } from '../gates';
import { puzzleRef, releaseHold } from '../puzzles';
import { questEvent } from '../quests';
import { emit, fail, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { relocate } from '../world';
import type { HandlerMap } from './util';

const DIR_ALIASES: Record<string, string> = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };

/** An exit of the room: a direction, a short alias or the id of an adjacent room. Fails when there is none. */
export function exitOf(room: Room, raw: string): { dir: string; to: string } {
  const key = raw.trim().toLowerCase();
  const dir = room.exits[key] ? key : (DIR_ALIASES[key] ?? Object.keys(room.exits).find((d) => room.exits[d] === key) ?? key);
  const to = room.exits[dir];
  if (!to) fail('TARGET_NOT_FOUND', 'no_exit', { dir: raw, exits: Object.keys(room.exits).join(', ') });
  return { dir, to };
}

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
    const { dir, to } = exitOf(room, p.dir);
    const gate = room.gates[dir];
    if (gate) {
      const block = gateBlocker(run, a, gate);
      if (block) fail(block.code, block.slug, block.params);
    }
    const held = (run.c.puzzlesByRoom.get(a.room) ?? []).find((pz) => pz.type === 'gate' && run.s.puzzles[pz.id]?.hold?.by === a.id);
    if (held && releaseHold(run, a)) tell(run, 'n.gate_released', { puzzle: puzzleRef(held.id) });
    enterRoom(run, a, to, dir);
    tell(run, 'n.move', { dir: ref.dir(dir), room: ref.room(to) });
    tell(run, `content.room.${to}.desc`);
    escortAfterMove(run, a);
  },
};
