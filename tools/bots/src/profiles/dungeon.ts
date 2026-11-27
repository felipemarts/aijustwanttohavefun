/**
 * Group content for parties and crowds: the Catacombs (levels 15 to 20) and the daily world boss.
 *
 * The dungeon is entered by a party of 3 or 4 with at least 2 classes (the stairs' party gate counts members standing
 * there or already below). Then: two levers pulled by different agents within a minute (two members online at once),
 * a trap only a Rogue disarms, a seal only a Mage reads, a gate a Warrior holds. A party camps in the deepest room its
 * level and classes reach, fights there, and recovers there (its members keep sharing the kills).
 */
import { route } from '@ajwf/engine';
import type { BotStep } from '../solo';
import { cmd, hpShare, partyHereSeen, travel } from './common';
import type { AgentView, DecideCtx } from './types';

const MIN = 60_000;

/** Dungeon camps, shallowest first: the leader's level they need and the classes that open the way to them. */
export const DUNGEON_CAMPS: { room: string; level: number; needs: string[] }[] = [
  { room: 'dungeon.lever_hall', level: 15, needs: [] },
  { room: 'dungeon.trapped_corridor', level: 17, needs: ['rogue'] },
  { room: 'dungeon.rune_door', level: 18, needs: ['rogue', 'mage'] },
];

export const DUNGEON_TUNING = {
  /** Members needed in the party (the party gate wants 3) and how long a member waits for the others at a puzzle. */
  minParty: 3,
  patienceMs: 25 * MIN,
  /** A party that could not get in leaves the dungeon alone for this long. */
  blockedMs: 3 * 60 * MIN,
  /** World boss: level and HP share to join the fight. */
  bossLevel: 10,
  bossAbove: 0.45,
} as const;
const D = DUNGEON_TUNING;

type DungeonMem = { blockedUntil: number; waitingSince: number; pulled: { puzzle: string; at: number } | null; classes: Map<string, string> };

function dmem(x: DecideCtx): DungeonMem {
  let m = x.mem.ext.dungeon as DungeonMem | undefined;
  if (!m) x.mem.ext.dungeon = m = { blockedUntil: 0, waitingSince: 0, pulled: null, classes: new Map() };
  return m;
}

/** Remembers the classes of party mates seen (to know whether the party can open the trap and the seal). */
export function noteMates(v: AgentView, x: DecideCtx): void {
  const m = dmem(x);
  const members = new Set(v.obs.you.party?.members ?? []);
  for (const name of [...m.classes.keys()]) if (!members.has(name)) m.classes.delete(name);
  for (const a of partyHereSeen(v)) if (a.class) m.classes.set(a.name, a.class);
}

/** The deepest dungeon camp this party can reach, or null (not strong enough, too few, or recently blocked). */
export function dungeonCamp(v: AgentView, x: DecideCtx, leadLevel: number): string | null {
  const m = dmem(x);
  const size = (v.obs.you.party?.members.length ?? 0) + 1;
  if (size < D.minParty || v.now < m.blockedUntil) return null;
  const classes = new Set([v.cls, ...m.classes.values()]);
  if (classes.size < 2) return null;
  let best: string | null = null;
  for (const c of DUNGEON_CAMPS) if (leadLevel >= c.level && c.needs.every((k) => classes.has(k))) best = c.room;
  return best;
}

/**
 * Walks towards a room through the dungeon's gates: works the puzzle that blocks the way when this bot can, or waits
 * for the party mate who can (giving up after a while). Null when the way is open (plain travel does it).
 */
export function throughGates(v: AgentView, x: DecideCtx, to: string): BotStep | null {
  const step = travel(v, x, to);
  if (step) {
    dmem(x).waitingSince = 0;
    return step;
  }
  const path = route(x.c, v.obs.room.id, to);
  const dir = path?.[0];
  const lock = dir ? v.obs.room.locked?.[dir] : undefined;
  if (!lock) return null;
  const m = dmem(x);
  if (!m.waitingSince) m.waitingSince = v.now;
  if (v.now - m.waitingSince > D.patienceMs) {
    m.blockedUntil = v.now + D.blockedMs;
    m.waitingSince = 0;
    return null;
  }
  if (lock === 'puzzle') {
    for (const pz of v.obs.room.puzzles ?? []) {
      if (pz.open) continue;
      if (pz.do === 'pull_lever' && pz.targets.length > 1) {
        // Two levers, two agents: pull one nobody pulled yet, once per window, with a party mate here.
        if (!partyHereSeen(v).length) break;
        if (m.pulled?.puzzle === pz.id && v.now - m.pulled.at < MIN) break;
        const free = pz.targets.find((t) => !(pz.pulled ?? []).includes(t));
        if (!free || v.obs.you.ap[0] < 1) break;
        m.pulled = { puzzle: pz.id, at: v.now };
        return cmd('pull_lever', { target: free });
      }
      if (pz.cls && pz.cls !== v.cls) continue;
      if (pz.do === 'disarm' || pz.do === 'read_runes') return v.obs.you.ap[0] >= 1 ? cmd(pz.do, { target: pz.targets[0]! }) : { wait: 2 * MIN };
    }
  }
  // The party gate or a puzzle for someone else: wait for the others.
  return { wait: 30_000 };
}

/** Joins the daily world boss while it is up: walks there and hits it. */
export function worldBoss(v: AgentView, x: DecideCtx): BotStep | null {
  const wb = v.obs.world_boss;
  if (!wb?.up || v.obs.you.lvl < D.bossLevel || hpShare(v) < D.bossAbove) return null;
  if (v.obs.room.id !== wb.room) return travel(v, x, wb.room);
  if (!v.obs.room.monsters.some((m) => m.id === wb.id)) return null;
  if (v.obs.you.ap[0] < 1) return { wait: 2 * MIN };
  return cmd('attack', { target: wb.id });
}
