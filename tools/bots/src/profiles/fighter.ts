/**
 * Fighter: hunts monsters of its level, alone. It follows the parts of the tutorial and the dailies it can do
 * without anyone else, keeps itself supplied, and ignores other agents.
 */
import { questKeep, absorbLast, hunt, keepSupplied, preyFor, quests, sellJunk, survive, keepGoing } from './common';
import { worldBoss } from './dungeon';
import { absorbTrust, honestTrust } from './trust';
import type { Profile } from './types';

export const fighter: Profile = {
  id: 'fighter',
  grouped: false,
  decide(v, x) {
    absorbLast(v, x);
    absorbTrust(v, x, null);
    return (
      survive(v, x, false) ??
      worldBoss(v, x) ??
      honestTrust(v, x, { buys: false, hunts: true }) ??
      keepGoing(v, x) ??
      keepSupplied(v, x) ??
      sellJunk(v, x, questKeep(v)) ??
      quests(v, x, { social: false, grouped: false }) ??
      hunt(v, x, preyFor(x.c, v.obs.you.lvl, false)) ?? { wait: 20_000 }
    );
  },
};
