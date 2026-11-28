/**
 * The seam between the core and "how a character thinks" (playkit README, section 1). The brain is the playkit:
 * prompt text, the menu, reading the model's answer, memory upkeep. The core supplies HTTP, storage, scheduling and
 * the engine, and never trusts the model: a decision reaches the game only after `resolve` validated it against the
 * menu, and the core checks the PvP rule once more before sending.
 */
import type { Kit } from '../playkit/kit.ts';
import type { Playkit } from '../playkit/index.ts';

export type Brain = Pick<
  Playkit,
  | 'version'
  | 'parseSchemaDoc'
  | 'buildTurn'
  | 'retryMessages'
  | 'decide'
  | 'resolve'
  | 'heard'
  | 'remember'
  | 'recentOf'
  | 'observe'
  | 'compactionTurn'
  | 'applyCompaction'
  | 'chatTurn'
  | 'wakes'
  | 'refreshesMe'
> & { readonly kit: Kit };
