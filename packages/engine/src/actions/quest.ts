import type { Quest } from '@ajwf/content';
import { hasOwnKey, ref } from '@ajwf/shared';
import { addGold, addItem, bump, canFit, count, gainXp, hasAll, removeItem } from '../agent';
import { BALANCE } from '../balance';
import { escortCheck, escortJoin } from '../escort';
import { partyHere } from '../party';
import { dailyQuests, initialProgress, nextTutorial, questBlocker, questEvent, questReady, questView } from '../quests';
import { route } from '../routes';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { addHonor } from '../trust';
import { questXpMult } from '../unlocks';
import { normId, type HandlerMap } from './util';

function questById(run: Run, raw: string): Quest {
  const q = run.c.quests.get(normId(raw));
  if (!q) fail('TARGET_NOT_FOUND', 'quest_unknown', { quest: raw });
  return q;
}

function needGiverHere(run: Run, a: AgentState, q: Quest): void {
  const npc = run.c.npcs.get(q.giver)!;
  if (npc.room === a.room) return;
  const path = route(run.c, a.room, npc.room);
  const max = BALANCE.routes.hintMax;
  const dirs = path ? path.slice(0, max).join(', ') + (path.length > max ? ', ...' : '') : npc.room;
  fail('NOT_AVAILABLE_HERE', 'quest_giver_elsewhere', { npc: ref.npc(npc.id), room: ref.room(npc.room), room_id: npc.room, path: dirs });
}

/** A newcomer finished a quest with veterans of its party at its side: they get credit for helping. */
function helpedNewbie(run: Run, a: AgentState): void {
  const P = BALANCE.party;
  if (a.level > P.newbieLevel || !a.party) return;
  for (const b of partyHere(run, a)) {
    if (b.level < a.level + P.helpNewbieGap) continue;
    bump(run, b, 'newbies_helped');
    addHonor(run, b, BALANCE.honor.newbie);
    questEvent(run, b, 'help_newbie');
    markAgent(run.s, b);
  }
}

const KIND_STAT: Record<Quest['kind'], string | null> = { tutorial: 'tutorial_done', daily: 'dailies_done', chain: 'chains_done', escort: 'escorts_done', side: null };

export const questActions: HandlerMap = {
  quest_list(run, a) {
    const active = Object.keys(a.quests)
      .map((id) => run.c.quests.get(id))
      .filter((q): q is Quest => !!q)
      .map((q) => questView(a, q));
    const here: string[] = [];
    for (const npc of run.c.npcsByRoom.get(a.room) ?? []) {
      for (const q of run.c.questsByGiver.get(npc.id) ?? []) if (!questBlocker(run, a, q)) here.push(q.id);
    }
    const next = nextTutorial(run, a);
    run.data.quests = {
      active,
      here,
      daily: dailyQuests(run.s, run.now, a.level).map((id) => ({ id, giver: run.c.quests.get(id)!.giver, done: hasOwnKey(a.questsDone, id) && questBlocker(run, a, run.c.quests.get(id)!) === 'done' })),
      ...(next && !hasOwnKey(a.quests, next.id) ? { next: { id: next.id, giver: next.giver, room: run.c.npcs.get(next.giver)!.room } } : {}),
    };
    tell(run, 'n.quest_list', { active: active.length, here: here.length });
    if (next && !hasOwnKey(a.quests, next.id)) tell(run, 'n.quest_next', { quest: ref.quest(next.id), npc: ref.npc(next.giver), room: ref.room(run.c.npcs.get(next.giver)!.room) });
  },

  quest_accept(run, a, p) {
    const q = questById(run, p.quest);
    const block = questBlocker(run, a, q);
    if (block === 'active') fail('CONFLICT', 'quest_active', { quest: ref.quest(q.id) });
    if (block === 'done') fail('CONFLICT', 'quest_done', { quest: ref.quest(q.id) });
    if (block === 'level') fail('LEVEL_REQUIRED', 'quest_level', { quest: ref.quest(q.id), level: q.level });
    if (block === 'requires') fail('NOT_ALLOWED', 'quest_requires', { quest: ref.quest(q.id), other: ref.quest(q.requires!) });
    if (block === 'not_today') fail('NOT_AVAILABLE_HERE', 'quest_not_today', { quest: ref.quest(q.id) });
    needGiverHere(run, a, q);
    if (Object.keys(a.quests).length >= BALANCE.inventory.maxActiveQuests) fail('CONFLICT', 'quest_too_many', { max: BALANCE.inventory.maxActiveQuests });
    if (!canFit(run.c, a, q.grants)) fail('INVENTORY_FULL', 'inventory_full');
    escortCheck(run, a, q);
    for (const g of q.grants) addItem(a, g.item, g.qty);
    a.quests[q.id] = { steps: initialProgress(run, a, q), at: run.now };
    tell(run, 'n.quest_accept', { quest: ref.quest(q.id) });
    tell(run, `content.quest.${q.id}.desc`);
    run.data.quest = questView(a, q);
    escortJoin(run, a, q);
    if (questReady(a, q)) tell(run, 'n.quest_ready', { quest: ref.quest(q.id), npc: ref.npc(q.giver) });
  },

  quest_turn_in(run, a, p) {
    const q = questById(run, p.quest);
    if (!hasOwnKey(a.quests, q.id)) fail('TARGET_NOT_FOUND', 'quest_not_active', { quest: ref.quest(q.id) });
    needGiverHere(run, a, q);
    if (!questReady(a, q)) {
      run.data.quest = questView(a, q);
      fail('NOT_ALLOWED', 'quest_incomplete', { quest: ref.quest(q.id) });
    }
    if (!hasAll(a, q.consume)) {
      const missing = q.consume.filter((s) => !(count(a, s.item) >= s.qty)).map((s) => `${s.item} x${s.qty - count(a, s.item)}`);
      fail('MISSING_ITEMS', 'quest_items', { quest: ref.quest(q.id), missing: missing.join(', ') });
    }
    if (!canFit(run.c, a, q.rewards.items, q.consume)) fail('INVENTORY_FULL', 'inventory_full');
    for (const s of q.consume) removeItem(a, s.item, s.qty);
    for (const s of q.rewards.items) addItem(a, s.item, s.qty);
    delete a.quests[q.id];
    a.questsDone[q.id] = run.now;
    // Before the reward XP, which may lift the newcomer out of the newbie levels.
    helpedNewbie(run, a);
    addGold(run, a, q.rewards.gold);
    tell(run, 'n.quest_done', { quest: ref.quest(q.id), gold: q.rewards.gold });
    for (const s of q.rewards.items) tell(run, 'n.loot', { item: ref.item(s.item), qty: s.qty });
    const xp = gainXp(run, a, Math.round(q.rewards.xp * questXpMult(run.s)));
    if (xp > 0) tell(run, 'n.xp', { xp });
    bump(run, a, 'quests_done');
    const stat = KIND_STAT[q.kind];
    if (stat) bump(run, a, stat);
    emit(run, 'quest_done', {
      room: a.room,
      actor: a.id,
      vis: q.kind === 'chain' ? 'public' : 'room',
      drama: q.kind === 'chain' ? 4 : 1,
      m: msg('ev.quest_done', { actor: a.name, quest: ref.quest(q.id) }),
      data: { quest: q.id, kind: q.kind, gold: q.rewards.gold },
    });
    const next = nextTutorial(run, a);
    if (q.kind === 'tutorial' && next) {
      const room = run.c.npcs.get(next.giver)!.room;
      tell(run, 'n.quest_next', { quest: ref.quest(next.id), npc: ref.npc(next.giver), room: ref.room(room) });
      run.data.next = { id: next.id, giver: next.giver, room };
    }
  },
};
