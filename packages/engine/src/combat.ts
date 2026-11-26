import { ref } from '@ajwf/shared';
import { addGold, bump, derive, fall, gainXp, giveOrDrop, touch } from './agent';
import { BALANCE, levelGapXpMod } from './balance';
import { questEvent } from './quests';
import { emit, fail, markAgent, markRoom, msg, tell, type Run } from './run';
import type { AgentState, MonsterInst } from './types';
import { refreshMonster, roomState } from './world';

/** max(1, atk * mult * rand(0.85..1.15) - def / 2), with a chance to crit. */
export function rollDamage(run: Run, atk: number, mult: number, def: number, critChance = 0): { dmg: number; crit: boolean } {
  const C = BALANCE.combat;
  const crit = critChance > 0 && run.rng.chance(critChance);
  const raw = atk * mult * run.rng.range(C.randMin, C.randMax) * (crit ? C.critMult : 1) - def * C.defFactor;
  return { dmg: Math.max(1, Math.round(raw)), crit };
}

/**
 * Finds the monster an agent means: an instance uid, or a kind id (preferring the one already fighting the agent).
 * With no target, the monster the agent is engaged with.
 */
export function findMonster(run: Run, a: AgentState, target: string | undefined): MonsterInst {
  const room = roomState(run.s, a.room);
  for (const m of room.monsters) refreshMonster(run.s, m, run.now);
  if (!target) {
    const cur = a.combat && room.monsters.find((m) => m.uid === a.combat!.mon);
    if (cur) return cur;
    if (room.monsters.length === 1) return room.monsters[0]!;
    fail('INVALID_PARAMS', 'need_target');
  }
  const id = target.trim().toLowerCase().replace(/^@?mon[:.]/, '').replace(/[\s-]+/g, '_');
  const byUid = room.monsters.find((m) => m.uid === id);
  if (byUid) return byUid;
  const same = room.monsters.filter((m) => m.kind === id);
  if (!same.length) fail('TARGET_NOT_FOUND', 'monster_not_here', { target });
  return (
    same.find((m) => m.uid === a.combat?.mon) ??
    same.find((m) => m.threat[a.id] !== undefined) ??
    same.find((m) => Object.keys(m.threat).length > 0) ??
    same[0]!
  );
}

/** Agents in the monster's threat table who are still standing in its room. */
export function fightersOf(run: Run, roomId: string, m: MonsterInst): AgentState[] {
  const out: AgentState[] = [];
  for (const id in m.threat) {
    const b = run.s.agents.get(id);
    if (b && b.room === roomId && !b.fallen) out.push(b);
  }
  return out;
}

/** The acting agent hits a monster. Returns true when the monster died (loot already resolved). */
export function strike(run: Run, a: AgentState, m: MonsterInst, mult: number, verb: 'attack' | 'skill' = 'attack', skill?: string): boolean {
  const kind = run.c.monsters.get(m.kind)!;
  const d = derive(run.c, a, run.now);
  const { dmg, crit } = rollDamage(run, d.atk, mult, kind.def, d.crit);
  const dealt = Math.min(dmg, m.hp);
  m.hp -= dealt;
  m.threat[a.id] = (m.threat[a.id] ?? 0) + dealt;
  m.lastHit = run.now;
  a.combat = { mon: m.uid, until: run.now + BALANCE.combat.engageMs };
  markRoom(run.s, a.room);
  tell(run, crit ? 'n.hit_crit' : 'n.hit', { target: ref.mon(m.kind), dmg, hp: Math.max(0, m.hp), max: kind.hp });
  emit(run, 'attack', {
    room: a.room,
    actor: a.id,
    target: m.uid,
    drama: kind.boss ? 3 : 1,
    m: msg(skill ? 'ev.cast_hit' : 'ev.attack', { actor: a.name, target: ref.mon(m.kind), dmg, ...(skill ? { skill: ref.skill(skill) } : {}) }),
    data: { mon: m.kind, dmg, crit, hp: Math.max(0, m.hp), verb },
  });
  if (m.hp <= 0) {
    killMonster(run, a.room, m);
    return true;
  }
  return false;
}

/** Damage to an agent from anything. Handles the fall. */
export function hurt(run: Run, victim: AgentState, dmg: number, by: string): void {
  victim.hp -= dmg;
  markAgent(run.s, victim);
  if (victim.hp <= 0) fall(run, victim, by);
}

/** The monster answers the blow: it hits whoever taunted it, otherwise the attacker. Bosses also sweep the room. */
export function retaliate(run: Run, a: AgentState, m: MonsterInst): void {
  const kind = run.c.monsters.get(m.kind)!;
  const fighters = fightersOf(run, a.room, m);
  let victim = a;
  if (m.taunt && m.taunt.until > run.now) {
    const t = run.s.agents.get(m.taunt.by);
    if (t && t.room === a.room && !t.fallen) victim = t;
  }
  if (victim.fallen) return;
  if (victim !== a) touch(run, victim);
  const crush = fighters.length <= 1 ? kind.solo_crush : 1;
  const by = ref.mon(m.kind);
  const { dmg } = rollDamage(run, kind.atk, crush, derive(run.c, victim, run.now).def);
  victim.combat = { mon: m.uid, until: run.now + BALANCE.combat.engageMs };
  if (victim === a) tell(run, 'n.monster_hits', { mon: by, dmg });
  else {
    tell(run, 'n.monster_hits_other', { mon: by, name: victim.name, dmg });
    emit(run, 'hit', { room: a.room, actor: victim.id, vis: 'private', to: [victim.id], m: msg('ev.monster_hits_you', { mon: by, dmg }), data: { dmg } });
  }
  hurt(run, victim, dmg, by);

  if (kind.aoe > 0) {
    for (const b of fighters) {
      if (b === victim || b.fallen) continue;
      if (b !== a) touch(run, b);
      const sweep = rollDamage(run, kind.aoe, 1, derive(run.c, b, run.now).def * 0.5).dmg;
      if (b === a) tell(run, 'n.boss_sweep', { mon: by, dmg: sweep });
      else emit(run, 'hit', { room: a.room, actor: b.id, vis: 'private', to: [b.id], m: msg('ev.boss_sweep_you', { mon: by, dmg: sweep }), data: { dmg: sweep } });
      hurt(run, b, sweep, by);
    }
  }
}

/** Removes the monster, schedules its respawn and shares XP, gold and drops among those who fought it. */
export function killMonster(run: Run, roomId: string, m: MonsterInst): void {
  const { s, c, now, rng } = run;
  const kind = c.monsters.get(m.kind)!;
  const room = roomState(s, roomId);
  room.monsters = room.monsters.filter((x) => x !== m);
  if (m.slot >= 0) {
    s.timers.push({ at: now + kind.respawn_sec * 1000, kind: 'respawn', room: roomId, slot: m.slot });
    s.dirty.add('timers');
  }
  markRoom(s, roomId);

  const shares: { agent: AgentState; dmg: number }[] = [];
  let total = 0;
  for (const id in m.threat) {
    const b = s.agents.get(id);
    const dmg = m.threat[id]!;
    if (!b || b.room !== roomId || dmg <= 0) continue;
    shares.push({ agent: b, dmg });
    total += dmg;
  }
  if (!shares.length || total <= 0) return;
  shares.sort((x, y) => y.dmg - x.dmg);

  const gold = rng.int(kind.gold[0], kind.gold[1]);
  // Gold is split by damage dealt; the last share takes the rounding remainder so nothing is created or lost.
  let goldLeft = gold;
  const parts = shares.map((sh, i) => {
    const part = i === shares.length - 1 ? goldLeft : Math.min(goldLeft, Math.round((gold * sh.dmg) / total));
    goldLeft -= part;
    return part;
  });
  const killer = run.actor && shares.some((x) => x.agent === run.actor) ? run.actor : shares[0]!.agent;

  emit(run, 'kill', {
    room: roomId,
    actor: killer.id,
    target: m.uid,
    to: 'room',
    drama: kind.world_boss ? 12 : kind.boss ? 10 : kind.elite ? 3 : 1,
    vis: kind.boss ? 'public' : 'room',
    m: msg('ev.kill', { actor: killer.name, target: ref.mon(m.kind) }),
    data: { mon: m.kind, boss: kind.boss, by: shares.map((x) => x.agent.name), gold: Object.fromEntries(shares.map((x, i) => [x.agent.id, parts[i]!])) },
  });

  shares.forEach((sh, i) => {
    const b = sh.agent;
    const share = sh.dmg / total;
    if (b !== run.actor) touch(run, b);
    if (b.combat?.mon === m.uid) b.combat = null;
    const part = parts[i]!;
    addGold(run, b, part);
    const xp = b.fallen ? 0 : gainXpFromKill(run, b, kind.xp * share, kind.level);
    if (b === run.actor) tell(run, 'n.kill', { target: ref.mon(m.kind), xp, gold: part });
    else emit(run, 'kill_share', { room: roomId, actor: b.id, vis: 'private', to: [b.id], m: msg('ev.kill_share', { target: ref.mon(m.kind), xp, gold: part }) });
    if (share >= BALANCE.combat.creditShare) {
      bump(run, b, 'kills');
      if (kind.elite) bump(run, b, 'kills_elite');
      if (kind.world_boss) bump(run, b, 'world_boss_kills');
      else if (kind.boss) bump(run, b, 'boss_kills');
      questEvent(run, b, 'kill', m.kind);
      if (kind.boss) questEvent(run, b, 'boss', m.kind);
    }
    markAgent(s, b);
  });

  for (const drop of kind.drops) {
    if (!rng.chance(drop.chance)) continue;
    let pick = rng.next() * total;
    let winner = shares[0]!.agent;
    for (const sh of shares) {
      pick -= sh.dmg;
      if (pick <= 0) {
        winner = sh.agent;
        break;
      }
    }
    awardLoot(run, winner, drop.item, drop.qty, m.kind);
  }
}

function gainXpFromKill(run: Run, b: AgentState, base: number, monLevel: number): number {
  return gainXp(run, b, base * levelGapXpMod(b.level, monLevel));
}

/** Hands a drop to an agent (or the floor, when the bags are full) and announces the good ones. */
export function awardLoot(run: Run, b: AgentState, itemId: string, qty: number, from: string): void {
  const item = run.c.items.get(itemId)!;
  const kept = giveOrDrop(run, b, itemId, qty);
  const p = { item: ref.item(itemId), qty };
  if (b === run.actor) tell(run, kept ? 'n.loot' : 'n.loot_ground', p);
  else emit(run, 'loot_share', { room: b.room, actor: b.id, vis: 'private', to: [b.id], m: msg(kept ? 'ev.loot_you' : 'ev.loot_you_ground', p) });
  if (item.rarity === 'legendary') bump(run, b, 'legendary_found');
  if (item.type === 'cosmetic') bump(run, b, 'cosmetics_found');
  if (item.rarity === 'epic' || item.rarity === 'legendary') {
    emit(run, 'rare_drop', {
      room: b.room,
      actor: b.id,
      vis: 'public',
      drama: item.rarity === 'legendary' ? 9 : 5,
      m: msg('ev.rare_drop', { actor: b.name, item: ref.item(itemId), mon: ref.mon(from) }),
      data: { item: itemId, rarity: item.rarity, mon: from },
    });
  }
  markAgent(run.s, b);
}
