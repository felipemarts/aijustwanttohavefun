import { ref } from '@ajwf/shared';
import { addGold, bump, derive, fall, gainXp, giveOrDrop, touch } from './agent';
import { BALANCE, levelGapXpMod, respawnDelayMs } from './balance';
import { raiseBond } from './bond';
import { bestFriendAtSide, markParty, partyOf } from './party';
import { questEvent } from './quests';
import { emit, fail, markAgent, markRoom, msg, tell, type Run } from './run';
import type { AgentState, MonsterInst, Party } from './types';
import { agentsIn, refreshMonster, roomState, scheduleRespawn, spawnSlots } from './world';
import { addHonor } from './trust';
import { worldBossKilled } from './worldboss';

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
  if (!same.length) {
    const back = respawnIn(run, a.room, id);
    if (back !== null) fail('TARGET_NOT_FOUND', 'monster_respawning', { target, seconds: back });
    fail('TARGET_NOT_FOUND', 'monster_not_here', { target });
  }
  return (
    same.find((m) => m.uid === a.combat?.mon) ??
    same.find((m) => m.threat[a.id] !== undefined) ??
    same.find((m) => Object.keys(m.threat).length > 0) ??
    same[0]!
  );
}

/** Seconds until the next monster of this kind comes back to the room, or null. Looks only at the room's pending respawns. */
export function respawnIn(run: Run, roomId: string, kind: string): number | null {
  const pending = run.s.respawns.get(roomId);
  if (!pending?.size) return null;
  const slots = spawnSlots(run.c, roomId);
  let next = Infinity;
  for (const [slot, at] of pending) if (slots[slot]?.kind === kind && at < next) next = at;
  return next === Infinity ? null : Math.max(1, Math.ceil((next - run.now) / 1000));
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
  const withFriend = bestFriendAtSide(run, a) ? 1 + BALANCE.bond.bestFriendDamage : 1;
  const roll = rollDamage(run, d.atk, mult * withFriend, kind.def, d.crit);
  const { crit } = roll;
  let dmg = roll.dmg;
  if (kind.min_group > 1) {
    // A group boss shrugs off most blows until enough agents fight it together.
    const n = fightersOf(run, a.room, m).filter((b) => b !== a).length + 1;
    if (n < kind.min_group) {
      dmg = Math.max(1, Math.round(dmg * BALANCE.group.underGroupDamage));
      tell(run, 'n.group_boss_weak', { mon: ref.mon(m.kind), n, need: kind.min_group });
    }
  }
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

/**
 * Who shares a kill. Each agent outside a party is its own side; the members of a party who are in the room and
 * standing form one side, with the damage of all of them, so a tank or a healer who dealt nothing still shares.
 */
type Side = { members: AgentState[]; dmg: number; party: Party | undefined };

function killSides(run: Run, roomId: string, m: MonsterInst): Side[] {
  const s = run.s;
  const byKey = new Map<string, Side & { dealers: AgentState[] }>();
  for (const id in m.threat) {
    const b = s.agents.get(id);
    const dmg = m.threat[id]!;
    if (!b || b.room !== roomId || dmg <= 0) continue;
    const party = partyOf(s, b);
    const key = party?.id ?? b.id;
    let side = byKey.get(key);
    if (!side) byKey.set(key, (side = { members: [], dmg: 0, party, dealers: [] }));
    side.dmg += dmg;
    side.dealers.push(b);
  }
  const sides = [...byKey.values()].map(({ dealers, ...side }) => {
    if (side.party) {
      const standing = side.party.members.map((id) => s.agents.get(id)!).filter((b) => b.room === roomId && !b.fallen);
      // Everyone who fought is down: they still split the gold (and, fallen, get no XP, like anyone fallen).
      side.members = standing.length ? standing : dealers;
    } else side.members = dealers;
    return side;
  });
  return sides.sort((x, y) => y.dmg - x.dmg);
}

/** Splits `amount` by weight; the last part takes the rounding remainder so nothing is created or lost. */
function splitByWeight(amount: number, weights: number[], total: number): number[] {
  let left = amount;
  return weights.map((w, i) => {
    const part = i === weights.length - 1 ? left : Math.min(left, Math.round((amount * w) / total));
    left -= part;
    return part;
  });
}

/** Even split; the remainder goes to the party leader (or the first member when the leader is not there). */
function splitEvenly(amount: number, side: Side): Map<AgentState, number> {
  const n = side.members.length;
  const out = new Map(side.members.map((b) => [b, Math.floor(amount / n)] as const));
  const head = side.members.find((b) => b.id === side.party?.leader) ?? side.members[0]!;
  out.set(head, out.get(head)! + (amount % n));
  return out;
}

/** Who in a side receives a drop: the party's rotation, its leader, or the lone fighter. */
function dropReceiver(run: Run, side: Side): AgentState {
  const p = side.party;
  if (!p || side.members.length === 1) return side.members[0]!;
  if (p.loot === 'leader') return side.members.find((b) => b.id === p.leader) ?? side.members[0]!;
  const b = side.members[p.rr % side.members.length]!;
  p.rr++;
  markParty(run.s, p);
  return b;
}

/** A veteran who fights alongside a newcomer in its party earns mentor points. */
function mentoring(run: Run, members: AgentState[]): void {
  const P = BALANCE.party;
  if (!members.some((b) => b.level <= P.newbieLevel)) return;
  for (const b of members) {
    if (b.level < P.mentorLevel) continue;
    bump(run, b, 'mentor_points');
    addHonor(run, b, BALANCE.honor.mentor);
    questEvent(run, b, 'mentor');
  }
}

/** Removes the monster, schedules its respawn and shares XP, gold and drops among those who fought it. */
export function killMonster(run: Run, roomId: string, m: MonsterInst): void {
  const { s, c, now, rng } = run;
  const kind = c.monsters.get(m.kind)!;
  const room = roomState(s, roomId);
  room.monsters = room.monsters.filter((x) => x !== m);
  if (m.slot >= 0) scheduleRespawn(s, roomId, m.slot, now + respawnDelayMs(kind.respawn_sec * 1000, agentsIn(s, roomId).size, kind.boss));
  if (kind.world_boss) worldBossKilled(s, m);
  markRoom(s, roomId);

  const sides = killSides(run, roomId, m);
  const total = sides.reduce((n, x) => n + x.dmg, 0);
  if (!sides.length || total <= 0) return;

  const gold = rng.int(kind.gold[0], kind.gold[1]);
  const sideGold = splitByWeight(gold, sides.map((x) => x.dmg), total);
  const goldOf = new Map<AgentState, number>();
  sides.forEach((side, i) => {
    for (const [b, g] of splitEvenly(sideGold[i]!, side)) goldOf.set(b, g);
  });
  const everyone = sides.flatMap((x) => x.members);
  const killer = run.actor && everyone.includes(run.actor) ? run.actor : everyone[0]!;

  emit(run, 'kill', {
    room: roomId,
    actor: killer.id,
    target: m.uid,
    to: 'room',
    drama: kind.world_boss ? 12 : kind.boss ? 10 : kind.elite ? 3 : 1,
    vis: kind.boss ? 'public' : 'room',
    m: msg('ev.kill', { actor: killer.name, target: ref.mon(m.kind) }),
    data: { mon: m.kind, boss: kind.boss, by: everyone.map((b) => b.name), gold: Object.fromEntries(everyone.map((b) => [b.id, goldOf.get(b)!])) },
  });

  const credited: AgentState[] = [];
  for (const side of sides) {
    const share = side.dmg / total;
    const n = side.members.length;
    // XP is not divided in a party: every member present receives the side's share in full, grown by the party's
    // size. Being there is what counts, not the damage. (Gold is still split evenly.)
    const xpEach = side.party ? kind.xp * share * (1 + BALANCE.party.xpPerExtraMember * (n - 1)) : kind.xp * share;
    const credit = share >= (kind.world_boss ? BALANCE.worldBoss.creditShare : BALANCE.combat.creditShare);
    for (const b of side.members) {
      if (b !== run.actor) touch(run, b);
      if (b.combat?.mon === m.uid) b.combat = null;
      const part = goldOf.get(b)!;
      addGold(run, b, part);
      const xp = b.fallen ? 0 : gainXpFromKill(run, b, xpEach, kind.level);
      if (b === run.actor) tell(run, 'n.kill', { target: ref.mon(m.kind), xp, gold: part });
      else emit(run, 'kill_share', { room: roomId, actor: b.id, vis: 'private', to: [b.id], m: msg('ev.kill_share', { target: ref.mon(m.kind), xp, gold: part }) });
      if (credit) {
        credited.push(b);
        bump(run, b, 'kills');
        if (kind.elite) bump(run, b, 'kills_elite');
        if (kind.world_boss) bump(run, b, 'world_boss_kills');
        else if (kind.boss) bump(run, b, 'boss_kills');
        questEvent(run, b, 'kill', m.kind);
        if (kind.boss) questEvent(run, b, 'boss', m.kind);
      }
      markAgent(s, b);
    }
    if (credit && side.party) mentoring(run, side.members);
  }

  // Fighting side by side builds bonds. Only the top damage dealers pair up, so a crowd at a world boss stays cheap.
  const pairs = credited.slice(0, BALANCE.bond.killPairsMax);
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) raiseBond(run, pairs[i]!, pairs[j]!, BALANCE.bond.kill);

  // A world boss: everyone with kill credit rolls the whole drop table for themselves.
  if (kind.world_boss) {
    for (const b of credited) for (const drop of kind.drops) if (rng.chance(drop.chance)) awardLoot(run, b, drop.item, drop.qty, m.kind);
    return;
  }
  for (const drop of kind.drops) {
    if (!rng.chance(drop.chance)) continue;
    let pick = rng.next() * total;
    let winner = sides[0]!;
    for (const side of sides) {
      pick -= side.dmg;
      if (pick <= 0) {
        winner = side;
        break;
      }
    }
    awardLoot(run, dropReceiver(run, winner), drop.item, drop.qty, m.kind);
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
