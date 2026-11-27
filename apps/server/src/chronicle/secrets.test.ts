import { describe, expect, it } from 'vitest';
import { isRevealed, revealedConversations, type SecretInput } from './secrets';
import { dailyStats, DayTally, dayKey, dayStart } from './stats';
import { recentPrices } from './prices';

const AT = 1_800_000_000_000;

describe('isRevealed (the one reveal check)', () => {
  const ev = { visibility: 'delayed', revealAt: AT };
  it('is false one millisecond before the reveal time', () => expect(isRevealed(ev, AT - 1)).toBe(false));
  it('is true exactly at the reveal time', () => expect(isRevealed(ev, AT)).toBe(true));
  it('is true after it', () => expect(isRevealed(ev, AT + 1)).toBe(true));
  it('never passes without a reveal time, or for another visibility', () => {
    expect(isRevealed({ visibility: 'delayed' }, Infinity)).toBe(false);
    expect(isRevealed({ visibility: 'delayed', revealAt: null }, Infinity)).toBe(false);
    expect(isRevealed({ visibility: 'delayed', revealAt: Number.NaN }, Infinity)).toBe(false);
    expect(isRevealed({ visibility: 'private', revealAt: AT }, AT + 1)).toBe(false);
    expect(isRevealed({ visibility: 'public', revealAt: AT }, AT + 1)).toBe(false);
  });
});

let n = 0;
function msg(o: Partial<SecretInput>): SecretInput {
  n++;
  return { id: String(n), seq: n, ts: AT + n * 60_000, revealAt: AT + n * 60_000 + 86_400_000, visibility: 'delayed', channel: 'whisper', from: 'Pip', to: 'Brasa', text: `m${n}`, lang: 'en', ...o };
}

describe('revealedConversations', () => {
  it('groups by pair or channel and by time, newest first, oldest message first, dropping what is not revealed', () => {
    const list = [
      msg({}),
      msg({ from: 'Brasa', to: 'Pip' }),
      msg({ channel: 'guild', group: 'g1', guild: 'Owls', from: 'Mira', to: undefined }),
      msg({ ts: AT + 3 * 3_600_000, revealAt: AT + 3 * 3_600_000 + 86_400_000 }),
      msg({ channel: 'party', group: 'p1', from: 'Tobias', to: undefined, revealAt: AT + 10 * 86_400_000 }),
    ];
    const now = AT + 2 * 86_400_000;
    const cs = revealedConversations(list, now);
    expect(cs.map((c) => [c.channel, c.messages.map((m) => m.text)])).toEqual([
      ['whisper', ['m4']],
      ['guild', ['m3']],
      ['whisper', ['m1', 'm2']],
    ]);
    expect(cs[2]!.agents.sort()).toEqual(['Brasa', 'Pip']);
    expect(cs[1]!.guild).toBe('Owls');
    expect(JSON.stringify(cs)).not.toContain('m5');
  });
});

describe('daily stats', () => {
  it('UTC day keys', () => {
    expect(dayKey(Date.UTC(2026, 10, 26, 23, 59, 59, 999))).toBe('2026-11-26');
    expect(dayKey(Date.UTC(2026, 10, 27))).toBe('2026-11-27');
    expect(dayStart('2026-11-27')).toBe(Date.UTC(2026, 10, 27));
  });

  it('tallies a day: newcomers, trades, average prices', () => {
    const t = new DayTally('2026-11-26');
    const base = { ts: AT, visibility: 'public' as const };
    t.consume({ ...base, id: '1', type: 'arrival', actor: 'a1', payload: {} }, () => 'Pip');
    t.consume({ ...base, id: '2', type: 'market_trade', payload: { item: 'wood', qty: 10, price: 3 } }, () => undefined);
    t.consume({ ...base, id: '3', type: 'market_trade', payload: { item: 'wood', qty: 10, price: 4 } }, () => undefined);
    t.consume({ ...base, id: '4', type: 'market_trade', payload: { item: 'ore', qty: 1, price: 10 } }, () => undefined);
    const s = dailyStats({ population: 3, onlinePeak: 2, projectsDone: 1, goldInCirculation: 500, tally: t });
    expect(s).toEqual({ date: '2026-11-26', population: 3, onlinePeak: 2, projects: 1, projectsToday: 0, goldInCirculation: 500, avgPrices: { wood: 3.5, ore: 10 }, trades: 3, newcomers: 1 });
  });

  it('recent prices: weighted by quantity, only within the window', () => {
    const h = [
      { item: 'wood', qty: 1, price: 10, buyer: 'a', seller: 'b', ts: AT - 8 * 86_400_000 },
      { item: 'wood', qty: 3, price: 2, buyer: 'a', seller: 'b', ts: AT - 1000 },
      { item: 'wood', qty: 1, price: 6, buyer: 'a', seller: 'b', ts: AT },
    ];
    expect(recentPrices(h, AT)).toEqual([{ item: 'wood', avg: 3, qty: 4, n: 2, last: AT }]);
  });
});
