import type { Quest, QuestStep } from '@ajwf/content';
import { createRng, hashString, hasOwnKey, own, ref } from '@ajwf/shared';
import { count } from './agent';
import { realDay } from './balance';
import { emit, markAgent, msg, tell, type Run } from './run';
import { partyHere } from './party';
import type { AgentState, WorldState } from './types';

export type StepType = QuestStep['type'];

/** Steps whose progress is read from the agent's current state instead of being counted. */
const STATE_STEPS = new Set<StepType>(['collect', 'level']);
/** Steps that only count while the agent has enough party members around (`party_min`). */
const PARTY_STEPS = new Set<StepType>(['kill', 'boss', 'puzzle', 'escort']);

/** Level brackets for dailies: everyone in a bracket is offered the same three quests. */
const BRACKET_LEVEL = [1, 5, 10, 12] as const;
/** Lowest quest level still offered to each bracket, so veterans are not sent to hunt slimes. */
const BRACKET_FLOOR = [1, 2, 5, 5] as const;

function bracketOf(level: number): number {
  let b = 0;
  for (let i = 0; i < BRACKET_LEVEL.length; i++) if (level >= BRACKET_LEVEL[i]!) b = i;
  return b;
}

/** The three daily quests on offer today for agents of this level: two tasks and one social. Same for everyone in a level bracket. */
export function dailyQuests(s: WorldState, now: number, level: number): string[] {
  const b = bracketOf(level);
  const cap = BRACKET_LEVEL[b]!;
  const floor = BRACKET_FLOOR[b]!;
  const rng = createRng(parseInt(hashString(`daily:${realDay(now)}:${b}`).slice(0, 8), 16));
  const dailies = [...s.content.quests.values()].filter((q) => q.kind === 'daily' && q.level <= cap);
  const tasks = rng.shuffle(dailies.filter((q) => !q.social && q.level >= floor));
  const social = rng.shuffle(dailies.filter((q) => q.social));
  return [...tasks.slice(0, 2), ...social.slice(0, 1)].map((q) => q.id);
}

export function isDone(a: AgentState, q: Quest, now: number): boolean {
  const at = own(a.questsDone, q.id);
  if (at === undefined) return false;
  return q.kind === 'daily' ? realDay(at) === realDay(now) : true;
}

/** Why the agent cannot take this quest right now, or null when it can. */
export function questBlocker(run: Run, a: AgentState, q: Quest): 'active' | 'done' | 'level' | 'requires' | 'not_today' | null {
  if (hasOwnKey(a.quests, q.id)) return 'active';
  if (isDone(a, q, run.now)) return 'done';
  if (a.level < q.level) return 'level';
  if (q.requires && !hasOwnKey(a.questsDone, q.requires)) return 'requires';
  if (q.kind === 'daily' && !dailyQuests(run.s, run.now, a.level).includes(q.id)) return 'not_today';
  return null;
}

/** Current progress of one step, capped at what the step needs. */
export function stepHave(a: AgentState, q: Quest, i: number): number {
  const st = q.steps[i]!;
  if (st.type === 'collect') return Math.min(st.qty, st.target ? count(a, st.target) : 0);
  if (st.type === 'level') return Math.min(st.qty, a.level);
  return Math.min(st.qty, own(a.quests, q.id)?.steps[i] ?? 0);
}

export function questReady(a: AgentState, q: Quest): boolean {
  return q.steps.every((st, i) => stepHave(a, q, i) >= st.qty);
}

/** Compact progress view used by `quest_list` and `talk`. */
export function questView(a: AgentState, q: Quest): Record<string, unknown> {
  return {
    id: q.id,
    kind: q.kind,
    giver: q.giver,
    steps: q.steps.map((st, i) => ({ do: st.type, ...(st.target ? { target: st.target } : {}), have: stepHave(a, q, i), need: st.qty })),
    ready: questReady(a, q),
    ...(q.party_min > 1 ? { party_min: q.party_min } : {}),
  };
}

/**
 * Something quest-relevant happened to an agent. Advances every matching step of its active quests and tells the
 * agent when a quest becomes ready to turn in.
 */
export function questEvent(run: Run, a: AgentState, type: StepType, target?: string, n = 1): void {
  let partySize = -1;
  for (const [qid, prog] of Object.entries(a.quests)) {
    const q = run.c.quests.get(qid);
    if (!q) continue;
    let changed = false;
    for (let i = 0; i < q.steps.length; i++) {
      const st = q.steps[i]!;
      if (st.type !== type || STATE_STEPS.has(type)) continue;
      if (st.target && st.target !== target) continue;
      if ((prog.steps[i] ?? 0) >= st.qty) continue;
      if (q.party_min > 1 && PARTY_STEPS.has(type)) {
        if (partySize < 0) partySize = partyHere(run, a).length;
        if (partySize < q.party_min) continue;
      }
      prog.steps[i] = Math.min(st.qty, (prog.steps[i] ?? 0) + n);
      changed = true;
    }
    if (!changed) continue;
    markAgent(run.s, a);
    if (questReady(a, q)) {
      const p = { quest: ref.quest(q.id), npc: ref.npc(q.giver) };
      if (run.actor === a) tell(run, 'n.quest_ready', p);
      else emit(run, 'quest_ready', { actor: a.id, vis: 'private', to: [a.id], m: msg('ev.quest_ready', p), data: { quest: q.id } });
    }
  }
}

/** Something beyond the class's starter weapon is equipped. */
function equippedBeyondStarter(run: Run, a: AgentState): boolean {
  const starter = run.c.classes.get(a.cls)?.starter.map((st) => st.item) ?? [];
  return Object.entries(a.equip).some(([slot, id]) => id !== null && !(slot === 'weapon' && starter.includes(id)));
}

/** Steps that are already true when the quest is accepted start as done (as far as their quantity allows). */
export function initialProgress(run: Run, a: AgentState, q: Quest): number[] {
  return q.steps.map((st) => {
    const done = (n: number) => Math.min(st.qty, n);
    switch (st.type) {
      case 'visit':
        return done(st.target === a.room ? 1 : 0);
      case 'profession':
        return done(a.profession ? 1 : 0);
      case 'party':
        return done(partyHere(run, a).length > 1 ? 1 : 0);
      case 'guild':
        return done(a.guild ? 1 : 0);
      case 'friend':
        return done(a.friends.length);
      case 'equip':
        if (st.target) return done(Object.values(a.equip).includes(st.target) ? 1 : 0);
        return done(equippedBeyondStarter(run, a) ? 1 : 0);
      default:
        return 0;
    }
  });
}

/** The next quest of the tutorial trail for this agent, if any. */
export function nextTutorial(run: Run, a: AgentState): Quest | undefined {
  for (const q of run.c.quests.values()) {
    if (q.kind !== 'tutorial' || hasOwnKey(a.questsDone, q.id)) continue;
    if (!q.requires || hasOwnKey(a.questsDone, q.requires)) return q;
  }
  return undefined;
}
