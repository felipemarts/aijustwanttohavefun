import { bump, canFit } from '../agent';
import { BALANCE } from '../balance';
import { raiseBond } from '../bond';
import { goodsView, isEmpty, missingGoods, parseGoods, putGoods, takeGoods } from '../goods';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import { closeTrade, openTrade, tradesOf } from '../trade';
import type { AgentState, Trade } from '../types';
import { agentHere, type HandlerMap } from './util';

/** An open trade by id; expired offers are refused even before the timer clears them. */
function liveTrade(run: Run, raw: string): Trade {
  const id = raw.trim().toLowerCase();
  const t = run.s.trades.get(id);
  if (!t) fail('TARGET_NOT_FOUND', 'trade_unknown', { trade: raw });
  if (t.expires <= run.now) fail('TARGET_NOT_FOUND', 'trade_expired', { trade: id, minutes: BALANCE.trade.ttlMs / 60_000 });
  return t;
}

export const tradeActions: HandlerMap = {
  trade_offer(run, a, p) {
    const b = agentHere(run, a, p.to);
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    const give = parseGoods(run, p.give);
    const want = parseGoods(run, p.want);
    if (isEmpty(give) && isEmpty(want)) fail('INVALID_PARAMS', 'trade_empty');
    const missing = missingGoods(a, give);
    if (missing.length) fail('MISSING_ITEMS', 'trade_missing', { missing: missing.join(', ') });
    const T = BALANCE.trade;
    if (tradesOf(run.s, a.id, run.now).filter((t) => t.from === a.id).length >= T.maxOffers) fail('CONFLICT', 'trade_offers_full', { max: T.maxOffers });
    if (tradesOf(run.s, b.id, run.now).length >= T.maxOpen) fail('CONFLICT', 'trade_target_busy', { name: b.name });
    const t = openTrade(run, a.id, b.id, give, want);
    const minutes = T.ttlMs / 60_000;
    run.data.trade = t.id;
    tell(run, 'n.trade_offer', { name: b.name, trade: t.id, minutes });
    emit(run, 'trade_offer', {
      room: a.room,
      actor: a.id,
      target: b.id,
      to: [b.id],
      m: msg('ev.trade_offer', { actor: a.name, trade: t.id, minutes }),
      data: { trade: t.id, give: goodsView(give), want: goodsView(want) },
    });
  },

  trade_accept(run, a, p) {
    const t = liveTrade(run, p.trade);
    if (t.to !== a.id) fail('NOT_ALLOWED', 'trade_not_yours', { trade: t.id });
    const from: AgentState | undefined = run.s.agents.get(t.from);
    if (!from || from.status !== 'active' || from.room !== a.room) fail('NOT_AVAILABLE_HERE', 'trade_partner_gone', { name: from?.name ?? '?' });
    // Things may have changed since the offer: check both sides again, then swap all at once or nothing.
    const theyLack = missingGoods(from, t.give);
    if (theyLack.length) fail('MISSING_ITEMS', 'trade_they_lack', { name: from.name, missing: theyLack.join(', ') });
    const iLack = missingGoods(a, t.want);
    if (iLack.length) fail('MISSING_ITEMS', 'trade_missing', { missing: iLack.join(', ') });
    if (!canFit(run.c, a, t.give.items, t.want.items)) fail('INVENTORY_FULL', 'inventory_full');
    if (!canFit(run.c, from, t.want.items, t.give.items)) fail('INVENTORY_FULL', 'inventory_full_other', { name: from.name });
    takeGoods(from, t.give);
    takeGoods(a, t.want);
    putGoods(run, a, t.give);
    putGoods(run, from, t.want);
    closeTrade(run.s, t.id);
    for (const x of [a, from]) {
      bump(run, x, 'trades');
      // Guaranteed trades cannot be scams, so every one of them is clean.
      bump(run, x, 'clean_trades');
      questEvent(run, x, 'trade');
      markAgent(run.s, x);
    }
    raiseBond(run, a, from, BALANCE.bond.trade);
    tell(run, 'n.trade_done', { name: from.name });
    emit(run, 'trade', {
      room: a.room,
      actor: from.id,
      target: a.id,
      to: [from.id],
      drama: 1,
      m: msg('ev.trade', { actor: from.name, name: a.name }),
      data: { trade: t.id, give: goodsView(t.give), want: goodsView(t.want) },
    });
  },

  trade_cancel(run, a, p) {
    const t = liveTrade(run, p.trade);
    if (t.from !== a.id && t.to !== a.id) fail('NOT_ALLOWED', 'trade_not_yours', { trade: t.id });
    closeTrade(run.s, t.id);
    const other = t.from === a.id ? t.to : t.from;
    tell(run, 'n.trade_cancelled', { trade: t.id });
    emit(run, 'trade_cancel', { room: a.room, actor: a.id, target: other, vis: 'private', to: [other], m: msg('ev.trade_cancel', { actor: a.name, trade: t.id }), data: { trade: t.id } });
  },
};
