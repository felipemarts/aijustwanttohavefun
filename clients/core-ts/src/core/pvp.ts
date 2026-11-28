/**
 * The PvP rule, checked by the core before anything is sent (core-api.ts `Directives.allowPvp`: "enforced by the
 * per-turn schema and again before sending"). The playkit's menu already makes these decisions impossible; this is
 * the second, independent check, using the same sources so the two always agree.
 */
import { arr, at, get, isTrue, text, type JV } from '../playkit/jv.ts';
import type { Kit } from '../playkit/kit.ts';
import { source } from '../playkit/schema.ts';
import type { Decision } from '../playkit/types.ts';

/** Why the decision would act against another player with PvP off, or null. */
export function pvpViolation(kit: Kit, d: Decision, obs: JV, me: JV, self: string): string | null {
  const c = kit.config;
  if (c.pvpActions.includes(d.action)) return `${d.action} is a PvP action`;
  const target = text(get(d.params, 'target'));
  if (target === '') return null;
  const monsters = source(kit, 'fair_monsters', obs, me) ?? [];
  if (d.action === 'attack' || d.action === 'taunt') return monsters.includes(target) ? null : `${d.action} on something that is not a monster here`;
  if (d.action === 'cast') {
    if (monsters.includes(target)) return null;
    // Only a supportive skill may target an agent (or the character itself).
    const skill = text(get(d.params, 'skill'));
    const supportive = arr(get(me, 'skills')).some((s) => text(get(s, 'id')) === skill && !isTrue(get(s, 'locked')) && c.supportiveSkillTargets.includes(text(get(s, 'target'))));
    const agents = arr(at(obs, 'room', 'agents')).map((a) => text(get(a, 'name')));
    if (supportive && (agents.includes(target) || target === self)) return null;
    return 'cast on an agent with a skill that is not supportive';
  }
  return null;
}
