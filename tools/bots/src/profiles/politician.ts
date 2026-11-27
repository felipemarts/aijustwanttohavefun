/**
 * Politician: levels like anyone (hunting alone, quests), and spends a share of its time on the village. It gathers
 * wood and stone and buys the materials projects need, contributes them at the town hall, runs for mayor in every
 * election once level 5, campaigns on the board (tag `campaign`, which voters read), votes, and as mayor sets the
 * priority project, a modest market tax, and funds the priority project from the treasury.
 *
 * It reads what projects still need from the public `/village` read model, as any agent can.
 */
import { BALANCE } from '@ajwf/engine';
import type { BotStep } from '../solo';
import {
  absorbLast,
  answerPending,
  buyFromShop,
  civicVote,
  cmd,
  contributeSomething,
  gather,
  have,
  hunt,
  keepSupplied,
  preyFor,
  questKeep,
  quests,
  sellJunk,
  stableHash,
  survive,
  travel,
  keepGoing,
} from './common';
import { worldBoss } from './dungeon';
import { absorbTrust, honestTrust } from './trust';
import type { AgentView, DecideCtx, Profile } from './types';

const MIN = 60_000;
export const POLITICIAN_TUNING = {
  /** Share of each real day spent on civic work rather than hunting (by hour slots). */
  civicShare: 0.5,
  campaignEveryMs: 4 * 60 * MIN,
  /** Gold kept for itself; above this, a share goes to projects. */
  keepGold: 120,
  taxRate: 0.03,
  /** Materials gathered for projects before walking to the town hall. */
  haul: 12,
} as const;
const P = POLITICIAN_TUNING;

/** Mayor duties at the town hall: priority, tax, funding. */
function mayorDuty(v: AgentView, x: DecideCtx): BotStep | null {
  if (!v.obs.actions?.includes('mayor_priority')) return null;
  const vil = v.village();
  const open = vil.projects.filter((p) => p.status === 'available');
  if (!open.length) return null;
  const best = [...open].sort((a, b) => b.progress - a.progress)[0]!;
  if (vil.priority === null || !open.some((p) => p.id === vil.priority)) return cmd('mayor_priority', { project: best.id });
  if (Math.abs(vil.taxRate - P.taxRate) > 1e-9 && !x.mem.ext.taxSet) {
    x.mem.ext.taxSet = true;
    return cmd('mayor_tax', { rate: P.taxRate });
  }
  const pri = open.find((p) => p.id === vil.priority);
  if (pri?.missing && pri.missing.gold > 0 && vil.treasury >= 20) return cmd('mayor_fund', { project: pri.id, gold: Math.min(vil.treasury, pri.missing.gold) });
  return null;
}

/** Elections: run once level 5 (at the town hall), campaign on the board every few hours while a candidate. */
function election(v: AgentView, x: DecideCtx): BotStep | null {
  const me = v.obs.you;
  if (me.lvl < BALANCE.election.runLevel) return null;
  if (v.obs.actions?.includes('run_for_mayor')) {
    x.mem.ext.running = true;
    x.mem.ext.campaignAt = 0;
    return cmd('run_for_mayor', { platform: `${v.name} for mayor: finish the bridge, fair taxes, a bigger inn.` });
  }
  if (!x.mem.ext.running || v.now - ((x.mem.ext.campaignAt as number | undefined) ?? 0) < P.campaignEveryMs) return null;
  if (!v.obs.room.flags.includes('board')) return v.obs.room.zone === 'village' ? travel(v, x, 'village.square') : null;
  if (v.now - x.mem.postedAt < BALANCE.board.postCooldownMs) return null;
  x.mem.postedAt = v.now;
  x.mem.ext.campaignAt = v.now;
  return cmd('board_post', { tag: 'campaign', text: `Vote ${v.name} for mayor! Every coin of the treasury goes to the projects.` });
}

/** Civic work: bring materials the open projects need, or buy a few, and give them at the town hall. */
function civicWork(v: AgentView, x: DecideCtx): BotStep | null {
  const vil = v.village();
  const open = vil.projects.filter((p) => p.status === 'available' && p.missing);
  if (!open.length) return null;
  const needed = new Map<string, number>();
  for (const p of open) for (const [item, qty] of Object.entries(p.missing!.items)) needed.set(item, (needed.get(item) ?? 0) + qty);
  const carried = [...needed.keys()].reduce((n, id) => n + have(v, id), 0);
  const spare = v.obs.you.gold - P.keepGold;
  if (carried >= P.haul || (carried > 0 && v.obs.room.zone === 'village') || (spare > 30 && carried > 0)) {
    const give = contributeSomething(v, x, spare > 0 ? 0.5 : 0, 10);
    if (give) return give;
  }
  // Buy a missing item a shop sells when there is gold to spare.
  if (spare > 60) {
    for (const item of needed.keys()) {
      const step = buyFromShop(v, x, item, 1);
      if (step) return step;
    }
  }
  const gatherable = ['wood', 'stone', 'silver_ore', 'crystal'].filter((id) => needed.has(id));
  if (gatherable.length) return gather(v, x, gatherable);
  if (spare > 30) return contributeSomething(v, x, 0.5, 10);
  return null;
}

export const politician: Profile = {
  id: 'politician',
  grouped: false,
  decide(v, x) {
    absorbLast(v, x);
    absorbTrust(v, x, null);
    const early =
      survive(v, x, false) ??
      worldBoss(v, x) ??
      keepGoing(v, x) ??
      answerPending(v, x, { friends: true, guild: true, trades: true }) ??
      honestTrust(v, x, { buys: true, hunts: true }) ??
      keepSupplied(v, x) ??
      sellJunk(v, x, new Set([...questKeep(v), 'wood', 'stone', 'silver_ore', 'crystal', 'iron_ingot', 'linen', 'pot', 'buckle'])) ??
      (v.obs.room.flags.includes('town_hall') ? mayorDuty(v, x) : null) ??
      election(v, x) ??
      civicVote(v, x);
    if (early) return early;
    const q = quests(v, x, { social: false, grouped: false, extra: ['vote', 'friend', 'trade'] });
    if (q) return q;
    const hour = Math.floor(v.now / (60 * MIN));
    const civicHour = ((hour + stableHash(v.name)) % 10) / 10 < P.civicShare;
    if (civicHour && v.obs.you.lvl >= 3) {
      const w = civicWork(v, x);
      if (w) return w;
    }
    // A mayor drops by the town hall every few hours to use its powers.
    if (x.mem.ext.mayorCheckAt === undefined || v.now - (x.mem.ext.mayorCheckAt as number) > 6 * 60 * MIN) {
      if (v.village().mayor?.name === v.name) {
        if (v.obs.room.flags.includes('town_hall')) x.mem.ext.mayorCheckAt = v.now;
        else return travel(v, x, 'village.town_hall') ?? { wait: 20_000 };
      } else x.mem.ext.mayorCheckAt = v.now;
    }
    return hunt(v, x, preyFor(x.c, v.obs.you.lvl, false)) ?? { wait: 20_000 };
  },
};
