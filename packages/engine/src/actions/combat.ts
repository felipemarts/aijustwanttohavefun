import type { Skill } from '@ajwf/content';
import { ref } from '@ajwf/shared';
import { addBuff, bump, derive, standUp, touch, wakeAtTemple } from '../agent';
import { BALANCE } from '../balance';
import { raiseBond } from '../bond';
import { findMonster, retaliate, strike } from '../combat';
import { emit, fail, markAgent, markRoom, msg, tell, type Run } from '../run';
import { partyHere } from '../party';
import type { AgentState, MonsterInst } from '../types';
import { refreshMonster, roomState } from '../world';
import { agentHere, normId, type HandlerMap } from './util';

const TAUNT_MS = 45_000;

/** Checks that the agent knows the skill and can pay for it right now. */
function readySkill(run: Run, a: AgentState, raw: string): Skill {
  const skill = run.c.skills.get(normId(raw));
  if (!skill) fail('TARGET_NOT_FOUND', 'skill_unknown', { skill: raw });
  if (skill.class !== a.cls) fail('CLASS_REQUIRED', 'skill_class', { skill: ref.skill(skill.id), class: ref.cls(skill.class) });
  if (a.level < skill.level) fail('LEVEL_REQUIRED', 'skill_level', { skill: ref.skill(skill.id), level: skill.level });
  const readyAt = a.cooldowns[`skill:${skill.id}`] ?? 0;
  if (readyAt > run.now) fail('COOLDOWN', 'skill_cooldown', { skill: ref.skill(skill.id), seconds: Math.ceil((readyAt - run.now) / 1000) });
  if (a.mp < skill.mp) fail('NOT_ENOUGH_MP', 'no_mp', { need: skill.mp, have: Math.floor(a.mp) });
  return skill;
}

function pay(run: Run, a: AgentState, skill: Skill): void {
  a.mp -= skill.mp;
  if (skill.cooldown_sec > 0) a.cooldowns[`skill:${skill.id}`] = run.now + skill.cooldown_sec * 1000;
}

function castSkill(run: Run, a: AgentState, rawSkill: string, target: string | undefined): void {
  const skill = readySkill(run, a, rawSkill);
  const sref = ref.skill(skill.id);
  switch (skill.kind) {
    case 'damage': {
      const m = findMonster(run, a, target);
      pay(run, a, skill);
      tell(run, 'n.cast', { skill: sref });
      if (!strike(run, a, m, skill.power, 'skill', skill.id)) retaliate(run, a, m);
      return;
    }
    case 'aoe': {
      const room = roomState(run.s, a.room);
      if (!room.monsters.length) fail('TARGET_NOT_FOUND', 'no_monsters_here');
      for (const m of room.monsters) refreshMonster(run.s, m, run.now);
      const first: MonsterInst = target ? findMonster(run, a, target) : (room.monsters.find((m) => m.uid === a.combat?.mon) ?? room.monsters[0]!);
      pay(run, a, skill);
      tell(run, 'n.cast', { skill: sref });
      let firstAlive = true;
      for (const m of [...room.monsters]) {
        const dead = strike(run, a, m, skill.power, 'skill', skill.id);
        if (m === first) firstAlive = !dead;
      }
      // Only the monster the mage was facing answers the blast.
      if (firstAlive && !a.fallen) retaliate(run, a, first);
      else if (!a.fallen) {
        const next = roomState(run.s, a.room).monsters.find((m) => m.threat[a.id] !== undefined);
        if (next) retaliate(run, a, next);
      }
      return;
    }
    case 'taunt': {
      const m = findMonster(run, a, target);
      pay(run, a, skill);
      m.taunt = { by: a.id, until: run.now + TAUNT_MS };
      m.threat[a.id] = m.threat[a.id] ?? 0;
      m.lastHit = run.now;
      a.combat = { mon: m.uid, until: run.now + BALANCE.combat.engageMs };
      bump(run, a, 'taunts');
      markRoom(run.s, a.room);
      tell(run, 'n.taunt', { target: ref.mon(m.kind), seconds: TAUNT_MS / 1000 });
      emit(run, 'taunt', { room: a.room, actor: a.id, target: m.uid, to: 'room', drama: 1, m: msg('ev.taunt', { actor: a.name, target: ref.mon(m.kind) }) });
      return;
    }
    case 'heal': {
      const b = target ? agentHere(run, a, target) : a;
      if (b.fallen) fail('NOT_ALLOWED', 'target_fallen', { name: b.name });
      if (b !== a) touch(run, b);
      const max = derive(run.c, b, run.now).maxHp;
      if (b.hp >= max) fail('NOT_ALLOWED', 'full_health', { name: b.name });
      pay(run, a, skill);
      const amount = Math.min(max - b.hp, Math.round(derive(run.c, a, run.now).int * skill.power * run.rng.range(0.9, 1.1) + a.level * 2));
      b.hp += amount;
      markAgent(run.s, b);
      if (b === a) tell(run, 'n.heal_self', { skill: sref, hp: Math.round(amount) });
      else {
        bump(run, a, 'heals');
        tell(run, 'n.heal_other', { skill: sref, name: b.name, hp: Math.round(amount) });
        emit(run, 'heal', { room: a.room, actor: a.id, target: b.id, to: 'room', drama: 1, m: msg('ev.heal', { actor: a.name, name: b.name, hp: Math.round(amount) }), data: { hp: Math.round(amount) } });
        raiseBond(run, a, b, BALANCE.bond.heal);
      }
      return;
    }
    case 'party_heal': {
      const members = partyHere(run, a).filter((b) => !b.fallen);
      pay(run, a, skill);
      const base = derive(run.c, a, run.now).int * skill.power + a.level * 2;
      let total = 0;
      const healed: AgentState[] = [];
      for (const b of members) {
        if (b !== a) touch(run, b);
        const amount = Math.max(0, Math.min(derive(run.c, b, run.now).maxHp - b.hp, Math.round(base * run.rng.range(0.9, 1.1))));
        b.hp += amount;
        total += amount;
        if (amount > 0 && b !== a) healed.push(b);
        markAgent(run.s, b);
      }
      for (const b of healed) raiseBond(run, a, b, BALANCE.bond.heal);
      if (members.length > 1) bump(run, a, 'heals');
      tell(run, 'n.heal_party', { skill: sref, hp: Math.round(total), n: members.length });
      emit(run, 'heal', { room: a.room, actor: a.id, to: 'room', drama: 1, m: msg('ev.heal_party', { actor: a.name, skill: sref }), data: { hp: Math.round(total) } });
      return;
    }
    case 'revive': {
      if (!target) fail('INVALID_PARAMS', 'need_target');
      const b = agentHere(run, a, target);
      if (!b.fallen) fail('NOT_ALLOWED', 'not_fallen', { name: b.name });
      pay(run, a, skill);
      standUp(run, b);
      bump(run, a, 'revives');
      tell(run, 'n.revive', { name: b.name });
      emit(run, 'revive', { room: a.room, actor: a.id, target: b.id, to: 'room', drama: 4, m: msg('ev.revive', { actor: a.name, name: b.name }) });
      raiseBond(run, a, b, BALANCE.bond.revive);
      return;
    }
    case 'buff':
    case 'shield': {
      if (!skill.buff) fail('INTERNAL', 'skill_misconfigured');
      const targets = skill.target === 'party' ? partyHere(run, a).filter((b) => !b.fallen) : [a];
      pay(run, a, skill);
      for (const b of targets) {
        addBuff(b, { id: skill.id, stat: skill.buff.stat, value: skill.buff.value, until: run.now + skill.buff.minutes * 60_000 });
        markAgent(run.s, b);
      }
      tell(run, 'n.buff', { skill: sref, minutes: skill.buff.minutes });
      emit(run, 'buff', { room: a.room, actor: a.id, to: targets.length > 1 ? targets.map((b) => b.id) : 'none', m: msg('ev.buff', { actor: a.name, skill: sref }) });
      return;
    }
    case 'escape': {
      if (!a.combat) fail('NOT_ALLOWED', 'not_in_combat');
      pay(run, a, skill);
      disengage(run, a);
      tell(run, 'n.vanish', { skill: sref });
      return;
    }
  }
}

/** Leaves the fight: every monster in the room forgets the agent. */
function disengage(run: Run, a: AgentState): void {
  for (const m of roomState(run.s, a.room).monsters) {
    delete m.threat[a.id];
    if (m.taunt?.by === a.id) m.taunt = null;
  }
  a.combat = null;
  markRoom(run.s, a.room);
}

export const combatActions: HandlerMap = {
  attack(run, a, p) {
    const m = findMonster(run, a, p.target);
    if (!strike(run, a, m, 1)) retaliate(run, a, m);
  },

  cast(run, a, p) {
    castSkill(run, a, p.skill, p.target);
  },

  taunt(run, a, p) {
    if (a.cls !== 'warrior') fail('CLASS_REQUIRED', 'class_only', { class: ref.cls('warrior') });
    castSkill(run, a, 'taunt', p.target);
  },

  revive(run, a, p) {
    if (a.cls !== 'cleric') fail('CLASS_REQUIRED', 'class_only', { class: ref.cls('cleric') });
    castSkill(run, a, 'revive', p.target);
  },

  flee(run, a) {
    const room = roomState(run.s, a.room);
    const m = a.combat && room.monsters.find((x) => x.uid === a.combat!.mon);
    if (!m) fail('NOT_ALLOWED', 'not_in_combat');
    const C = BALANCE.combat;
    const chance = Math.min(C.fleeMax, C.fleeBase + derive(run.c, a, run.now).agi * C.fleePerAgi);
    if (run.rng.chance(chance)) {
      disengage(run, a);
      tell(run, 'n.flee_ok', { mon: ref.mon(m.kind) });
      emit(run, 'flee', { room: a.room, actor: a.id, m: msg('ev.flee', { actor: a.name, mon: ref.mon(m.kind) }) });
    } else {
      tell(run, 'n.flee_fail', { mon: ref.mon(m.kind) });
      retaliate(run, a, m);
    }
  },

  release(run, a) {
    if (!a.fallen) fail('NOT_ALLOWED', 'not_fallen_self');
    wakeAtTemple(run, a);
  },
};
