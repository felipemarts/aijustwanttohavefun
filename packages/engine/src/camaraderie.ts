import { addBuff } from './agent';
import { BALANCE } from './balance';
import { talkBond } from './bond';
import { markRoom, tell, type Run } from './run';
import type { AgentState } from './types';
import { roomState } from './world';

const BUFF_ID = 'camaraderie';

/**
 * An agent spoke in its room. The room remembers its latest few speakers, which is all that is needed to tell
 * whether a conversation is going on: no scan of the room. Speaking with others who spoke recently bonds the pair
 * (when they are still here); having stayed a while also earns the camaraderie XP buff.
 */
export function noteSpeech(run: Run, a: AgentState): void {
  const C = BALANCE.camaraderie;
  const room = roomState(run.s, a.room);
  const recent = room.said.filter((n) => n.by !== a.id && run.now - n.at <= C.windowMs);
  for (const note of recent) {
    const b = run.s.agents.get(note.by);
    if (b && b.room === a.room && b.status === 'active') talkBond(run, a, b);
  }
  room.said = [...recent, { by: a.id, at: run.now }].slice(-C.speakersKept);
  markRoom(run.s, a.room);

  if (!recent.length || run.now - a.roomAt < C.stayMs) return;
  const value = run.c.rooms.get(a.room)!.flags.includes('tavern') ? C.tavernXp : C.xp;
  const had = a.buffs.find((b) => b.id === BUFF_ID && b.until > run.now);
  addBuff(a, { id: BUFF_ID, stat: 'xp', value, until: run.now + C.durationMs });
  // Only news is narrated: a fresh buff or a stronger one. Refreshing the timer is silent.
  if (!had || had.value < value) tell(run, 'n.camaraderie', { pct: Math.round(value * 100), minutes: C.durationMs / 60_000 });
}
