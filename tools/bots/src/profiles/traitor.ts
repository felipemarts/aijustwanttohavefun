/**
 * Traitor: plays like `social` (it groups up, chats, makes friends: that is how it earns trust) and takes its
 * chances when they come, tried in order before anything else: keep hitting whoever it picked a fight with, betray
 * a party mate in a lawless room, steal (Rogues, lawless rooms and the village at night), ambush a weaker stranger,
 * empty the guild treasury as an officer and leave, plot a guild coup, and offer pay-first deals it never delivers.
 * Every one of them is within the rules the server enforces (level 8 and a gap of at most 5 for PvP and theft).
 */
import type { BotStep } from '../solo';
import { decideSocial } from './social';
import { ambush, betrayParty, keepFighting, lootGuild, plotCoup, scamDeal, stealHere } from './trust';
import type { AgentView, DecideCtx, Profile } from './types';

/** The traitor's opportunistic actions, tried in order before the social policy; each returns a step or null. */
export const OPPORTUNISTIC: ((v: AgentView, x: DecideCtx) => BotStep | null)[] = [keepFighting, betrayParty, stealHere, ambush, lootGuild, plotCoup, scamDeal];

export const traitor: Profile = { id: 'traitor', grouped: true, decide: (v, x) => decideSocial(v, x, OPPORTUNISTIC, 'traitor') };
