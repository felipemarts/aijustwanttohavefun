import { describe, expect, it } from 'vitest';
import { assessStuck, latestNews, nudgeSuggestion, stuckReason } from './progress';
import type { CharacterSummary, LogEntry } from '../core/types';

let n = 0;
const e = (over: Partial<LogEntry>): LogEntry => ({ id: String(++n).padStart(6, '0'), ts: 1_000_000 + n, kind: 'action', text: 'x', ...over });
const t = (k: string, p?: Record<string, string | number>) => `${k}${p ? JSON.stringify(p) : ''}`;

describe('latestNews', () => {
  it('prefers a recent big moment, else the last thing done or seen (not the client\'s own lines)', () => {
    const now = 2_000_000;
    const big = e({ kind: 'event', text: 'Level up!', big: true, ts: now - 60_000 });
    const move = e({ text: 'You walk north.', ts: now - 5_000 });
    const sys = e({ kind: 'system', text: 'Session started.', ts: now - 1_000 });
    expect(latestNews([sys, move, big], now)).toEqual({ entry: big, big: true });
    expect(latestNews([sys, move, { ...big, ts: now - 3_600_000 }], now)).toEqual({ entry: move, big: false });
    expect(latestNews([sys], now)).toBeNull();
  });
});

describe('assessStuck', () => {
  it('flags repeated refusals', () => {
    const turns = [e({ kind: 'refused' }), e({ kind: 'refused' }), e({}), e({ kind: 'refused' }), e({ kind: 'refused' }), e({})];
    expect(assessStuck(turns, 'playing')).toBe('refusals');
  });

  it('flags going back and forth without earning anything', () => {
    const a = { action: 'move', text: 'You walk north to the tavern.' };
    const b = { action: 'move', text: 'You walk south to the square.' };
    const turns = [a, b, a, b, a, b, a, b].map((x) => e(x));
    expect(assessStuck(turns, 'thinking')).toBe('no_progress');
    // The same walk with a reward in it is progress, not a loop.
    turns[3] = e({ ...b, delta: { xp: 10 } });
    expect(assessStuck(turns, 'thinking')).toBeNull();
  });

  it('is quiet with few turns, varied turns, or when the character is not meant to play', () => {
    expect(assessStuck([e({ kind: 'refused' }), e({ kind: 'refused' })], 'playing')).toBeNull();
    expect(assessStuck(Array.from({ length: 8 }, (_, i) => e({ text: `step ${i}` })), 'playing')).toBeNull();
    const refusals = Array.from({ length: 6 }, () => e({ kind: 'refused' }));
    expect(assessStuck(refusals, 'paused')).toBeNull();
    expect(assessStuck(refusals, 'blocked')).toBeNull();
    // System lines and events between turns do not count as turns.
    expect(assessStuck([...refusals.slice(0, 3), e({ kind: 'system' }), e({ kind: 'event' }), ...refusals.slice(3)], 'resting')).toBe('refusals');
  });
});

describe('nudgeSuggestion', () => {
  const quest = (ready: boolean, have: number) => ({ id: 'q', name: 't02_tools', ready, steps: [{ text: 'Buy a pickaxe', have, need: 1 }] });
  it('points at a quest ready to turn in, then at the next open step, else a generic hint', () => {
    expect(nudgeSuggestion(t, 'no_progress', [quest(true, 1)])).toBe('nudge.turnIn{"quest":"t02_tools"}');
    expect(nudgeSuggestion(t, 'no_progress', [quest(false, 0)])).toBe('nudge.quest{"quest":"t02_tools","step":"Buy a pickaxe"}');
    expect(nudgeSuggestion(t, 'no_progress', [])).toBe('nudge.noProgress');
    expect(nudgeSuggestion(t, 'refusals', undefined)).toBe('nudge.generic');
  });
});

describe('stuckReason', () => {
  const c = (over: Partial<CharacterSummary>) => ({ status: 'playing', ...over }) as CharacterSummary;
  const loop = Array.from({ length: 8 }, (_, i) => e({ action: 'move', text: i % 2 ? 'north' : 'south' }));
  it('uses the core\'s reason when it sends one', () => {
    expect(stuckReason(c({ stuck: { since: 1, reason: 'lost' } }), true, loop)).toBe('lost');
  });
  it('trusts the core once it reports stuck at all: absent means not stuck', () => {
    expect(stuckReason(c({}), true, loop)).toBeNull();
  });
  it('falls back to its own detection for a core that never sends it', () => {
    expect(stuckReason(c({}), false, loop)).toBe('no_progress');
  });
  it('suggests going back to the quest giver when lost', () => {
    expect(nudgeSuggestion(t, 'lost', [{ id: 'q', name: 'q', ready: true, steps: [] }])).toBe('nudge.lost');
  });
});
