import { own } from '@ajwf/shared';
import type { Content } from '@ajwf/content';
import { BALANCE } from './balance';
import type { AgentState, WorldState } from './types';

/**
 * What finished village projects unlock (the `unlocks` flags of projects.yaml). Every system asks here, through one
 * small helper per question, instead of reading project state itself. All of them cost O(number of projects).
 */

const byFlag = new WeakMap<Content, Map<string, string[]>>();

/** Ids of the projects whose completion unlocks `flag`. */
function projectsUnlocking(c: Content, flag: string): string[] {
  let m = byFlag.get(c);
  if (!m) {
    m = new Map();
    for (const p of c.projects.values()) for (const f of p.unlocks) m.set(f, [...(m.get(f) ?? []), p.id]);
    byFlag.set(c, m);
  }
  return m.get(flag) ?? [];
}

export function isProjectDone(s: WorldState, projectId: string): boolean {
  return own(s.village.projects, projectId)?.doneAt !== undefined;
}

/** Is this unlock flag in effect (some finished project grants it)? */
export function isUnlocked(s: WorldState, flag: string): boolean {
  return projectsUnlocking(s.content, flag).some((id) => isProjectDone(s, id));
}

/** Is this flag in effect at this room, i.e. granted by a finished project built there (the arena's ring)? */
export function unlockedAt(s: WorldState, flag: string, room: string): boolean {
  return projectsUnlocking(s.content, flag).some((id) => s.content.projects.get(id)!.site === room && isProjectDone(s, id));
}

// `mines_shortcut` needs no helper: the `project` gates (gates.ts) open when their project is done.
// `sieges` has no effect yet.

/** `market_slots`: open sell orders allowed per agent. */
export function marketSlots(s: WorldState): number {
  return BALANCE.market.maxOrders * (isUnlocked(s, 'market_slots') ? BALANCE.village.marketSlotsMult : 1);
}

/** `tavern_camaraderie`: Camaraderie XP bonus earned in the tavern. */
export function tavernCamaraderieXp(s: WorldState): number {
  return isUnlocked(s, 'tavern_camaraderie') ? BALANCE.village.innTavernXp : BALANCE.camaraderie.tavernXp;
}

/** `world_boss_warning`: the watchtower announces world bosses ahead of time (read by the world-boss code). */
export function worldBossWarning(s: WorldState): boolean {
  return isUnlocked(s, 'world_boss_warning');
}

/** `mage_library`: multiplier on the XP of quest rewards. */
export function questXpMult(s: WorldState): number {
  return isUnlocked(s, 'mage_library') ? 1 + BALANCE.village.libraryQuestXp : 1;
}

export const LIBRARY_BUFF = 'library';
/** A buff that never runs out (JSON has no Infinity). */
const FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * `mage_library`: Mages get more maximum MP, as a permanent buff applied lazily the next time the Mage is brought
 * up to date (no scan of all agents when the library opens). Returns true when the buff was just added.
 */
export function applyLibrary(s: WorldState, a: AgentState): boolean {
  if (a.cls !== 'mage' || a.buffs.some((b) => b.id === LIBRARY_BUFF) || !isUnlocked(s, 'mage_library')) return false;
  a.buffs.push({ id: LIBRARY_BUFF, stat: 'max_mp', value: BALANCE.village.libraryMageMp, until: FOREVER });
  return true;
}
