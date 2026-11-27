/**
 * Traitor (placeholder): behaves like `social` for now. The betrayal actions (PvP on party mates, scams with
 * `give`, theft, bounties) are being written in another branch; when they land, add their behaviours to
 * `OPPORTUNISTIC`, which the traitor tries before everything else.
 */
import type { BotStep } from '../solo';
import { decideSocial } from './social';
import type { AgentView, DecideCtx, Profile } from './types';

/**
 * EXTENSION POINT: opportunistic actions, tried in order before the social policy. Each one returns a step when it
 * sees its chance (a lone party mate in a lawless zone, a trusting trade partner...), or null. Empty today.
 */
export const OPPORTUNISTIC: ((v: AgentView, x: DecideCtx) => BotStep | null)[] = [];

export const traitor: Profile = { id: 'traitor', grouped: true, decide: (v, x) => decideSocial(v, x, OPPORTUNISTIC) };
