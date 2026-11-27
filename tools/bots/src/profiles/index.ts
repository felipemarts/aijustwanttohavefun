import { explorer } from './explorer';
import { fighter } from './fighter';
import { politician } from './politician';
import { social } from './social';
import { trader } from './trader';
import { traitor } from './traitor';
import { commit } from './common';
import type { Profile, ProfileId } from './types';

/** Every profile's step goes through `commit`, which turns a walk towards a destination into a goal kept until reached. */
const committed = (p: Profile): Profile => ({ ...p, decide: (v, x) => commit(x, p.decide(v, x), v.now) });

export const PROFILES: Record<ProfileId, Profile> = {
  explorer: committed(explorer),
  fighter: committed(fighter),
  social: committed(social),
  trader: committed(trader),
  politician: committed(politician),
  traitor: committed(traitor),
};

export { OPPORTUNISTIC } from './traitor';
export { decideSocial, SOCIAL_TUNING } from './social';
export { TRADE_PLAN, TRADER_TUNING } from './trader';
export { POLITICIAN_TUNING } from './politician';
export * from './types';
