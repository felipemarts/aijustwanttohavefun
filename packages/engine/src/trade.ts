import { BALANCE } from './balance';
import type { Run } from './run';
import type { Goods, Trade, WorldState } from './types';

function index(s: WorldState, agentId: string): Set<string> {
  let set = s.tradesOf.get(agentId);
  if (!set) s.tradesOf.set(agentId, (set = new Set()));
  return set;
}

export function indexTrade(s: WorldState, t: Trade): void {
  index(s, t.from).add(t.id);
  index(s, t.to).add(t.id);
}

/** Open trades an agent is part of, either side. Expired ones are skipped (the timer removes them later). */
export function tradesOf(s: WorldState, agentId: string, now: number): Trade[] {
  const out: Trade[] = [];
  for (const id of s.tradesOf.get(agentId) ?? []) {
    const t = s.trades.get(id);
    if (t && t.expires > now) out.push(t);
  }
  return out;
}

export function openTrade(run: Run, from: string, to: string, give: Goods, want: Goods): Trade {
  const s = run.s;
  const t: Trade = { id: `t${(++s.meta.tradeSeq).toString(36)}`, from, to, give, want, expires: run.now + BALANCE.trade.ttlMs };
  s.trades.set(t.id, t);
  indexTrade(s, t);
  s.timers.push({ at: t.expires, kind: 'trade', id: t.id });
  for (const key of ['trades', 'timers', 'meta']) s.dirty.add(key);
  return t;
}

export function closeTrade(s: WorldState, id: string): void {
  const t = s.trades.get(id);
  if (!t) return;
  s.trades.delete(id);
  for (const who of [t.from, t.to]) {
    const set = s.tradesOf.get(who);
    set?.delete(id);
    if (set && !set.size) s.tradesOf.delete(who);
  }
  s.dirty.add('trades');
}
