import { describe, expect, it } from 'vitest';
import { eventPoints, INTEREST, INTEREST_POINTS, type InterestIncrement, SayTracker, selectIncrements } from './interest';

describe('eventPoints', () => {
  it('is the base weight of the type plus the drama', () => {
    expect(eventPoints({ type: 'fallen', drama: 6 })).toBe(16);
    expect(eventPoints({ type: 'level_up', drama: 3 })).toBe(8);
    expect(eventPoints({ type: 'move' })).toBe(0.5);
    expect(eventPoints({ type: 'something_new' })).toBe(INTEREST.defaultPoints);
    // the fountain events are scored by name before they exist here
    expect(eventPoints({ type: 'wish' })).toBe(2);
    expect(eventPoints({ type: 'fountain_jackpot' })).toBe(10);
  });

  it('scores boss kills, world firsts and PvP attacks higher than their plain type', () => {
    expect(eventPoints({ type: 'kill' })).toBe(4);
    expect(eventPoints({ type: 'kill', boss: true })).toBe(10);
    expect(eventPoints({ type: 'achievement' })).toBe(6);
    expect(eventPoints({ type: 'achievement', worldFirst: true })).toBe(10);
    expect(eventPoints({ type: 'attack' })).toBe(3);
    expect(eventPoints({ type: 'attack', vsAgent: true })).toBe(8);
    // the flags mean nothing on other types
    expect(eventPoints({ type: 'heal', boss: true, worldFirst: true, vsAgent: true })).toBe(3);
  });

  it('a conversation beats a monologue, and bots score less', () => {
    expect(eventPoints({ type: 'say' })).toBe(2);
    expect(eventPoints({ type: 'say', conversation: true })).toBe(4);
    expect(eventPoints({ type: 'fallen', drama: 5, bot: true })).toBeCloseTo(15 * INTEREST.botFactor);
  });

  it('ignores a drama that is not a positive number', () => {
    expect(eventPoints({ type: 'kill', drama: -5 })).toBe(4);
    expect(eventPoints({ type: 'kill', drama: Number.NaN })).toBe(4);
  });

  it('keeps every weight in the table positive', () => {
    for (const [type, p] of Object.entries(INTEREST_POINTS)) expect(p, type).toBeGreaterThan(0);
  });
});

describe('selectIncrements', () => {
  const inc = (n: string, p: number): InterestIncrement => ({ n, r: 'r', p, e: 'kill' });

  it('drops small increments and keeps the largest, in their original order', () => {
    const list = [inc('a', 1.9), inc('b', 5), inc('c', 2), inc('d', 9), inc('e', 3)];
    expect(selectIncrements(list).map((x) => x.n)).toEqual(['b', 'c', 'd', 'e']);
    expect(selectIncrements(list, 2).map((x) => x.n)).toEqual(['b', 'd']);
  });
});

describe('SayTracker', () => {
  it('tells an answer from a monologue', () => {
    const t = new SayTracker();
    expect(t.spoke('square', 'Pip', 0)).toBe(false);
    expect(t.spoke('square', 'Pip', 1000)).toBe(false);
    expect(t.spoke('square', 'Bo', 5000)).toBe(true);
    expect(t.spoke('tavern', 'Cy', 5000)).toBe(false);
    // too late: Bo's line is more than 20 s old
    expect(t.spoke('square', 'Pip', 5000 + INTEREST.conversationMs + 1)).toBe(false);
    t.prune(10 * 60_000);
    expect(t.spoke('square', 'Bo', 10 * 60_000)).toBe(false);
  });
});
