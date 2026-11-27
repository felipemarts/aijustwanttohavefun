import { ref } from '@ajwf/shared';
import { BALANCE } from './balance';
import { emit, markRoom, msg, type Run } from './run';
import type { MonsterInst, WorldState } from './types';

const DAY = 24 * 3_600_000;

/** The first scheduled appearance strictly after `now`: every real day at the same UTC hour. */
export function nextWorldBossAt(now: number): number {
  const at = Math.floor(now / DAY) * DAY + BALANCE.worldBoss.hourUtc * 3_600_000;
  return at > now ? at : at + DAY;
}

/**
 * How long before it appears the world boss is announced. One place on purpose: the village watchtower project
 * will lengthen it.
 */
export function worldBossLeadMs(_s: WorldState): number {
  return BALANCE.worldBoss.leadMs;
}

function configured(s: WorldState): boolean {
  const W = BALANCE.worldBoss;
  return s.content.monsters.has(W.monster) && s.content.rooms.has(W.room);
}

/** Sets the next appearance after `now` and pushes its timers (announce, then spawn). */
export function scheduleWorldBoss(s: WorldState, now: number): void {
  if (!configured(s)) return;
  const wb = s.worldBoss;
  wb.next = nextWorldBossAt(now);
  pushTimers(s, now);
}

/** The announce and spawn timers of the scheduled appearance (and the leave timer of a living boss). */
export function pushTimers(s: WorldState, now: number): void {
  const wb = s.worldBoss;
  if (wb.announced !== wb.next) s.timers.push({ at: Math.max(now, wb.next - worldBossLeadMs(s)), kind: 'wboss', step: 'announce' });
  s.timers.push({ at: wb.next, kind: 'wboss', step: 'spawn' });
  if (wb.uid) s.timers.push({ at: wb.leaves, kind: 'wboss', step: 'leave' });
  s.dirty.add('wboss');
}

function living(s: WorldState): MonsterInst | undefined {
  const wb = s.worldBoss;
  if (!wb.uid) return undefined;
  return s.rooms.get(BALANCE.worldBoss.room)?.monsters.find((m) => m.uid === wb.uid);
}

/** Runs one step of the schedule. Each step checks the state first, so stale or duplicate timers do nothing. */
export function worldBossTimer(run: Run, step: 'announce' | 'spawn' | 'leave'): void {
  const { s, now } = run;
  if (!configured(s)) return;
  const W = BALANCE.worldBoss;
  const wb = s.worldBoss;
  const mon = ref.mon(W.monster);
  const room = ref.room(W.room);
  const need = s.content.monsters.get(W.monster)!.min_group;
  if (step === 'announce') {
    if (wb.announced === wb.next || now >= wb.next) return;
    wb.announced = wb.next;
    s.dirty.add('wboss');
    const minutes = Math.max(1, Math.round((wb.next - now) / 60_000));
    emit(run, 'world_boss_soon', { room: W.room, vis: 'public', drama: 7, m: msg('ev.world_boss_soon', { mon, room, minutes, need }), data: { mon: W.monster, at: wb.next } });
    return;
  }
  if (step === 'spawn') {
    if (now < wb.next) return;
    if (!living(s)) {
      const kind = s.content.monsters.get(W.monster)!;
      const inst: MonsterInst = { uid: `m${(++s.meta.monsterSeq).toString(36)}`, kind: W.monster, hp: kind.hp, slot: -1, threat: {}, taunt: null, lastHit: 0 };
      s.rooms.get(W.room)!.monsters.push(inst);
      markRoom(s, W.room);
      s.dirty.add('meta');
      wb.uid = inst.uid;
      wb.leaves = now + W.stayMs;
      emit(run, 'world_boss', { room: W.room, target: inst.uid, vis: 'public', to: 'room', drama: 10, m: msg('ev.world_boss_spawn', { mon, room, need }), data: { mon: W.monster } });
    }
    wb.next = nextWorldBossAt(now);
    pushTimers(s, now);
    return;
  }
  // leave
  const m = living(s);
  if (!m) {
    if (wb.uid) {
      wb.uid = null;
      s.dirty.add('wboss');
    }
    return;
  }
  if (now < wb.leaves) return;
  const st = s.rooms.get(W.room)!;
  st.monsters = st.monsters.filter((x) => x !== m);
  for (const id of Object.keys(m.threat)) {
    const a = s.agents.get(id);
    if (a?.combat?.mon === m.uid) a.combat = null;
  }
  wb.uid = null;
  s.dirty.add('wboss');
  markRoom(s, W.room);
  emit(run, 'world_boss_left', { room: W.room, vis: 'public', to: 'room', drama: 6, m: msg('ev.world_boss_left', { mon, room }), data: { mon: W.monster } });
}

/** A killed world boss frees its schedule (called from killMonster). */
export function worldBossKilled(s: WorldState, m: MonsterInst): void {
  if (s.worldBoss.uid === m.uid) {
    s.worldBoss.uid = null;
    s.dirty.add('wboss');
  }
}

export type WorldBossInfo = { monster: string; room: string; at: number; up: boolean; leaves?: number };

/** The world boss as the server and the observation see it: in the world now, or when it next appears. */
export function worldBossInfo(s: WorldState): WorldBossInfo | null {
  if (!configured(s)) return null;
  const W = BALANCE.worldBoss;
  const wb = s.worldBoss;
  if (living(s)) return { monster: W.monster, room: W.room, at: wb.next, up: true, leaves: wb.leaves };
  return { monster: W.monster, room: W.room, at: wb.next, up: false };
}
