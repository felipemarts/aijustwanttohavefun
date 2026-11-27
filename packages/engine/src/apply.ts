import { actionParamSchemas, isActionName, type ActionName } from '@ajwf/shared';
import { touch } from './agent';
import { apCost, BALANCE } from './balance';
import { boardActions } from './actions/board';
import { chatActions } from './actions/chat';
import { civicActions } from './actions/civic';
import { combatActions } from './actions/combat';
import { duelActions } from './actions/duel';
import { fountainActions } from './actions/fountain';
import { friendActions } from './actions/friends';
import { guildActions } from './actions/guild';
import { marketActions } from './actions/market';
import { partyActions } from './actions/party';
import { tradeActions } from './actions/trade';
import { itemActions } from './actions/items';
import { moveActions } from './actions/move';
import { npcActions } from './actions/npc';
import { questActions } from './actions/quest';
import type { Handler, HandlerMap } from './actions/util';
import { trustActions } from './actions/trust';
import { utilityActions } from './actions/utility';
import { workActions } from './actions/work';
import { fail, GameError, markAgent, msg, newRun, type Run } from './run';
import type { ActionCtx, AgentState, ApplyResult, Command, WorldState } from './types';
import { covers } from './ledger';

/** Every action the engine currently implements. Later milestones add their modules here. */
export const HANDLERS: HandlerMap = {
  ...moveActions,
  ...combatActions,
  ...itemActions,
  ...npcActions,
  ...workActions,
  ...questActions,
  ...chatActions,
  ...friendActions,
  ...partyActions,
  ...tradeActions,
  ...marketActions,
  ...duelActions,
  ...boardActions,
  ...guildActions,
  ...utilityActions,
  ...civicActions,
  ...trustActions,
  ...fountainActions,
};

/** What a fallen agent can still do: call for help, give up and wait at the temple, read. */
const WHILE_FALLEN = new Set<ActionName>(['release', 'say', 'whisper', 'party_say', 'guild_say', 'inventory', 'quest_list', 'board_read', 'set_language', 'report_scam']);

/**
 * Agents without a confirmed owner cannot write free text, give things away or take part in politics (§15.1). Nor
 * wish at the fountain: its pot would let free accounts funnel their starting gold to someone else.
 */
const NEEDS_OWNER = new Set<ActionName>([
  'say', 'whisper', 'party_say', 'guild_say', 'board_post', 'board_reply', 'journal', 'give', 'vote', 'run_for_mayor', 'guild_create', 'wish',
]);

/** Free-text channels a muted agent loses. */
const TEXT_ACTIONS = new Set<ActionName>(['say', 'whisper', 'party_say', 'guild_say', 'board_post', 'board_reply', 'journal', 'run_for_mayor']);

/** Things that cannot be done while a monster is on you: leave (use `flee`), rest, work, shop. */
const NOT_IN_COMBAT = new Set<ActionName>([
  'move', 'rest', 'gather', 'craft', 'shop_buy', 'shop_sell', 'market_sell', 'market_buy', 'contribute', 'choose_profession', 'quest_accept', 'quest_turn_in',
  'duel_invite', 'duel_accept', 'pull_lever', 'hold_gate', 'read_runes', 'disarm', 'pick_lock', 'steal',
]);

function guard(run: Run, a: AgentState, action: ActionName): void {
  if (a.fallen && !WHILE_FALLEN.has(action)) {
    fail('DEAD', 'fallen', { seconds: Math.max(1, Math.ceil((a.fallen.until - run.now) / 1000)) });
  }
  if (!a.claimed && NEEDS_OWNER.has(action)) fail('UNCLAIMED_LIMIT', 'unclaimed', { action });
  if (a.mutedUntil > run.now && TEXT_ACTIONS.has(action)) fail('MUTED', 'muted', { minutes: Math.ceil((a.mutedUntil - run.now) / 60_000) });
  if (a.combat && NOT_IN_COMBAT.has(action)) fail('IN_COMBAT', 'in_combat', { action });
  const cost = apCost(action);
  if (!covers(a.ap, cost)) {
    const wait = Math.ceil((BALANCE.ap.regenMs - (run.now - a.apAt)) / 60_000);
    fail('NOT_ENOUGH_AP', 'no_ap', { need: cost, have: a.ap, minutes: Math.max(1, wait) });
  }
}

/**
 * The heart of the game: applies one command to the world. Pure apart from mutating `state`: the clock and the
 * randomness come from `ctx`, so the same inputs always give the same result (PLANEJAMENTO §3.2).
 */
export function applyAction(s: WorldState, cmd: Command, ctx: ActionCtx): ApplyResult {
  const a = s.agents.get(cmd.agentId);
  if (!a || a.status !== 'active') {
    return { result: { ok: false, action: cmd.action, error: { code: 'UNAUTHORIZED', msg: msg('err.unknown_agent') } }, events: [] };
  }
  if (!isActionName(cmd.action) || !HANDLERS[cmd.action]) {
    return {
      result: { ok: false, action: cmd.action, error: { code: 'INVALID_ACTION', msg: msg('err.invalid_action', { action: cmd.action }), hint: msg('hint.invalid_action') } },
      events: [],
    };
  }
  const action: ActionName = cmd.action;
  const parsed = actionParamSchemas[action].safeParse(cmd.params ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '?';
    return {
      result: { ok: false, action, error: { code: 'INVALID_PARAMS', msg: msg('err.invalid_params', { action, field }), hint: msg('hint.invalid_params', { action }) } },
      events: [],
    };
  }
  return applyParsed(s, a, action, parsed.data, ctx);
}

/**
 * Runs a handler on params that already passed the action's schema. `applyAction` is the only production caller;
 * the fuzzers call it directly with hostile params, to prove that the engine holds even without the boundary
 * checks of the schemas (prototype names, number ranges).
 *
 * Errors: a `GameError` (from `fail`) is a normal refusal. Any other exception is a bug: it becomes an `INTERNAL`
 * refusal and is handed back in `internal` for the server to log and count, instead of escaping. Handlers check
 * everything before they change anything (and the gold and item primitives of ledger.ts check their amounts before
 * they move), so a refusal leaves the world as it was; the fuzzers assert that the serialized world is unchanged
 * after every refusal, INTERNAL ones included. A general rollback (copying what a handler may touch) would cost
 * more than the whole action at the target load, so the guarantee is by construction and by test, not by undo.
 */
export function applyParsed(s: WorldState, a: AgentState, action: ActionName, params: unknown, ctx: ActionCtx): ApplyResult {
  const run = newRun(s, ctx.now, ctx.rng, a, ctx.luck);
  try {
    touch(run, a);
    guard(run, a, action);
    (HANDLERS[action] as Handler<ActionName>)(run, a, params as never);
    a.ap -= apCost(action);
    a.lastActiveAt = ctx.now;
    markAgent(s, a);
    const hasData = Object.keys(run.data).length > 0;
    return { result: { ok: true, action, narration: run.narr, ...(hasData ? { data: run.data } : {}) }, events: run.events };
  } catch (e) {
    markAgent(s, a);
    if (!(e instanceof GameError)) {
      return {
        result: { ok: false, action, error: { code: 'INTERNAL', msg: msg('err.internal'), hint: msg('hint.internal') } },
        // Normally only the events of `touch` (waking at the temple). Anything a buggy handler emitted before throwing
        // already reached inboxes, so it is published too rather than leaving inboxes and the log out of step.
        events: run.events,
        internal: e,
      };
    }
    const hasData = Object.keys(run.data).length > 0;
    return {
      result: {
        ok: false,
        action,
        error: { code: e.code, msg: msg(`err.${e.slug}`, e.params), hint: msg(`hint.${e.slug}`, e.params), ...(hasData ? { data: run.data } : {}) },
      },
      // `touch` may have produced events (waking at the temple) before the action was refused.
      events: run.events,
    };
  }
}
