import { ref } from '@ajwf/shared';
import { addGold, bump, derive, fall, giveOrDrop, removeItem, touch } from './agent';
import { BALANCE } from './balance';
import { dropBond, bondScore } from './bond';
import { rollDamage } from './combat';
import { markParty, partyOf, removeMember } from './party';
import { emit, fail, markAgent, msg, tell, type Run } from './run';
import { addHonor, bountyOn, claimBounty, isWanted, raiseInfamy } from './trust';
import type { AgentState } from './types';
import { agentByName } from './actions/util';
import { refreshMonster, roomState } from './world';

/**
 * Player against player (PLANEJAMENTO §7.3): only in lawless rooms, only between agents of level 8 or more whose
 * levels are at most 5 apart. A round is one blow each: the attacker strikes, the target strikes back.
 */

/** Whether rooms of this id allow PvP and theft at any hour. */
export function isLawless(run: Run, roomId: string): boolean {
  return run.c.rooms.get(roomId)?.flags.includes('lawless') ?? false;
}

/**
 * The agent an `attack` or `cast` names, when it names one: monsters come first, so an agent name only matches
 * when no living monster of that uid or kind is in the room. Null means "look for a monster" (with its own errors).
 */
export function pvpTarget(run: Run, a: AgentState, target: string | undefined): AgentState | null {
  if (!target) return null;
  const room = roomState(run.s, a.room);
  const id = target.trim().toLowerCase().replace(/^@?mon[:.]/, '').replace(/[\s-]+/g, '_');
  for (const m of room.monsters) {
    refreshMonster(run.s, m, run.now);
    if (m.uid === id || m.kind === id) return null;
  }
  const b = agentByName(run, target);
  if (!b) return null;
  if (b.room !== a.room) {
    // Not a monster here, and a known agent elsewhere: say so rather than "no such monster".
    if (!run.c.monsters.has(id)) fail('TARGET_NOT_FOUND', 'agent_not_here', { name: b.name });
    return null;
  }
  return b;
}

/** The rules of a fight between agents (shared by theft): refuses before anything changes. */
export function checkPvpPair(run: Run, a: AgentState, b: AgentState, allowedHere: boolean, theft = false): void {
  const P = BALANCE.pvp;
  if (b === a) fail('INVALID_PARAMS', 'pvp_self');
  if (!allowedHere) fail('SAFE_ZONE', theft ? 'steal_place' : 'pvp_safe_zone');
  if (a.level < P.minLevel) fail('LEVEL_REQUIRED', 'pvp_level', { level: P.minLevel });
  if (b.level < P.minLevel) fail('LEVEL_REQUIRED', 'pvp_target_level', { name: b.name, level: P.minLevel });
  if (Math.abs(a.level - b.level) > P.maxGap) fail('LEVEL_GAP', 'pvp_level_gap', { name: b.name, gap: P.maxGap });
  if (b.fallen) fail('NOT_ALLOWED', 'pvp_target_fallen', { name: b.name });
}

/** Attacking a member of one's own party: announced once per victim per party, and the traitor is cast out. */
function betray(run: Run, a: AgentState, b: AgentState): void {
  const party = partyOf(run.s, a);
  if (!party || b.party !== party.id) return;
  const key = `${a.id}>${b.id}`;
  if (party.betrayed?.includes(key)) return;
  party.betrayed = [...(party.betrayed ?? []), key];
  markParty(run.s, party);
  const members = party.members.map((id) => run.s.agents.get(id)!);
  const names = members.map((x) => x.name);
  removeMember(run.s, a);
  // The bond with the victim is gone; with everyone else in the party, half of it.
  dropBond(run, a, b, bondScore(a, b));
  for (const x of members) if (x !== a && x !== b) dropBond(run, a, x, Math.ceil(bondScore(a, x) / 2));
  bump(run, a, 'betrayals');
  addHonor(run, a, BALANCE.honor.betrayal);
  tell(run, 'n.betrayal', { name: b.name });
  emit(run, 'betrayal', {
    room: a.room,
    actor: a.id,
    target: b.id,
    vis: 'public',
    to: members.map((x) => x.id),
    drama: 15,
    m: msg('ev.betrayal', { actor: a.name, name: b.name }),
    data: { traitor: a.name, victim: b.name, party: names },
  });
  markAgent(run.s, a);
}

/** One blow between agents. Returns true when the one struck went down. */
function blow(run: Run, from: AgentState, to: AgentState, mult: number, skill: string | undefined, counter: boolean): boolean {
  const d = derive(run.c, from, run.now);
  const { dmg, crit } = rollDamage(run, d.atk, mult, derive(run.c, to, run.now).def, d.crit);
  to.hp -= dmg;
  markAgent(run.s, to);
  const hp = Math.max(0, Math.ceil(to.hp));
  const max = derive(run.c, to, run.now).maxHp;
  if (run.actor === from) tell(run, crit ? 'n.pvp_hit_crit' : 'n.pvp_hit', { name: to.name, dmg, hp, max });
  else if (run.actor === to) tell(run, 'n.pvp_hit_back', { name: from.name, dmg });
  emit(run, 'attack', {
    room: from.room,
    actor: from.id,
    target: to.id,
    // The victim must know who is hitting it; the attacker reads its own narration.
    to: 'room',
    drama: counter ? 3 : 4,
    m: msg(counter ? 'ev.pvp_hit_back' : skill ? 'ev.pvp_cast' : 'ev.pvp_attack', { actor: from.name, name: to.name, dmg, ...(skill ? { skill: ref.skill(skill) } : {}) }),
    data: { pvp: true, victim: to.name, dmg, crit, hp, verb: skill ? 'skill' : 'attack', ...(counter ? { counter: true } : {}) },
  });
  return to.hp <= 0;
}

/**
 * A round of PvP: `a` strikes `b` (a skill multiplier for `cast`), and `b` strikes back if still standing.
 * The caller validated the pair with `checkPvpPair` and paid for any skill.
 */
export function pvpRound(run: Run, a: AgentState, b: AgentState, mult: number, skill?: string): void {
  touch(run, b);
  betray(run, a, b);
  if (blow(run, a, b, mult, skill, false)) {
    pvpKill(run, a, b, false);
    return;
  }
  if (blow(run, b, a, 1, undefined, true)) pvpKill(run, b, a, true);
}

/**
 * An agent fell to another: a quarter of its carried gold and one random unequipped item (never a quest item)
 * go to the killer (the item to the ground when the killer's bags are full). Equipped items never drop. This toll
 * replaces the usual loss at the temple. The killer gains Infamy, unless the victim was Wanted, had a bounty on
 * its head, or started the fight (`defense`).
 */
export function pvpKill(run: Run, killer: AgentState, victim: AgentState, defense: boolean): void {
  const P = BALANCE.pvp;
  const outlaw = isWanted(victim) || bountyOn(run.s, victim.id) > 0;
  const gold = Math.floor(victim.gold * P.goldShare);
  victim.gold -= gold;
  addGold(run, killer, gold);
  let item: string | undefined;
  let kept = true;
  const loose = Object.keys(victim.inv).filter((id) => run.c.items.get(id)?.type !== 'quest' && (victim.inv[id] ?? 0) > 0);
  if (loose.length) {
    item = run.rng.pick(loose);
    removeItem(victim, item, 1);
    kept = giveOrDrop(run, killer, item, 1);
  }
  fall(run, victim, killer.name, true);
  bump(run, killer, 'pvp_kills');
  if (!defense && !outlaw) raiseInfamy(run, killer, BALANCE.infamy.kill);
  markAgent(run.s, killer);
  markAgent(run.s, victim);
  const p = { name: victim.name, gold, ...(item ? { item: ref.item(item) } : {}) };
  if (run.actor === killer) tell(run, item ? (kept ? 'n.pvp_kill_item' : 'n.pvp_kill_item_ground') : 'n.pvp_kill', p);
  else if (run.actor === victim) tell(run, item ? 'n.pvp_killed_item' : 'n.pvp_killed', { name: killer.name, gold, ...(item ? { item: ref.item(item) } : {}) });
  emit(run, 'pvp_kill', {
    room: victim.room,
    actor: killer.id,
    target: victim.id,
    vis: 'public',
    to: 'room',
    drama: 10,
    m: msg(item ? 'ev.pvp_kill_item' : 'ev.pvp_kill', { actor: killer.name, name: victim.name, gold, ...(item ? { item: ref.item(item) } : {}) }),
    data: { killer: killer.name, victim: victim.name, gold, ...(item ? { item } : {}), room: victim.room },
  });
  claimBounty(run, killer, victim);
}
