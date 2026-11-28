/**
 * Reading progress at a glance, from what the contract already gives: the recent log entries of a character.
 * Pure, so it is tested. The core knows more (quest state over time); see the report's proposal for a `stuck` field.
 */
import type { CharacterStatus, CharacterSummary, LogEntry, QuestProgress } from '../core/types';

/** How far back a big moment (level up, fall, rare loot) stays the headline of a card. */
export const BIG_NEWS_MS = 15 * 60_000;

/** The line a card shows: the latest big moment if recent, else the latest thing the character did or saw. */
export function latestNews(entries: LogEntry[], now: number): { entry: LogEntry; big: boolean } | null {
  const big = entries.find((e) => e.big && now - e.ts < BIG_NEWS_MS);
  if (big) return { entry: big, big: true };
  const last = entries.find((e) => e.kind === 'action' || e.kind === 'event' || e.kind === 'refused');
  return last ? { entry: last, big: false } : null;
}

/** The contract's reasons; the interface's own detection uses the first two. */
export type StuckReason = NonNullable<CharacterSummary['stuck']>['reason'];

const TURNS = (entries: LogEntry[]) => entries.filter((e) => e.kind === 'action' || e.kind === 'refused');

/**
 * The interface's own guess, used only with a core that does not send `stuck` (see `stuckReason`). From the last
 * turns (newest first):
 *   - refusals: at least 4 of its last 6 turns were refused by the game;
 *   - no_progress: its last 8 turns produced at most 2 different results and earned nothing (no XP, gold or level),
 *     for example walking back and forth between two rooms.
 * Only while it is meant to be playing: a paused, blocked or fallen character is not "stuck", it is waiting.
 */
export function assessStuck(entries: LogEntry[], status: CharacterStatus): StuckReason | null {
  if (status !== 'playing' && status !== 'thinking' && status !== 'resting') return null;
  const turns = TURNS(entries);
  const last6 = turns.slice(0, 6);
  if (last6.length >= 6 && last6.filter((e) => e.kind === 'refused').length >= 4) return 'refusals';
  const last8 = turns.slice(0, 8);
  if (last8.length >= 8) {
    const gained = last8.some((e) => (e.delta?.xp ?? 0) > 0 || (e.delta?.gold ?? 0) > 0 || (e.delta?.level ?? 0) > 0);
    const outcomes = new Set(last8.map((e) => `${e.action ?? ''}|${e.text}`));
    if (!gained && outcomes.size <= 2) return 'no_progress';
  }
  return null;
}

/** A suggested command for the owner to edit and send: built from the quests when it can be. */
export function nudgeSuggestion(
  t: (key: string, params?: Record<string, string | number>) => string,
  reason: StuckReason | null,
  quests: QuestProgress[] | undefined,
): string {
  if (reason === 'lost') return t('nudge.lost');
  const ready = quests?.find((q) => q.ready);
  if (ready) return t('nudge.turnIn', { quest: ready.name });
  const open = quests?.find((q) => q.steps.some((s) => s.have < s.need));
  const step = open?.steps.find((s) => s.have < s.need);
  if (open && step) return t('nudge.quest', { quest: open.name, step: step.text });
  return reason === 'no_progress' ? t('nudge.noProgress') : t('nudge.generic');
}

/** The reason to show: the core's when it reports `stuck` at all, else the interface's own guess. */
export function stuckReason(c: CharacterSummary, coreReportsStuck: boolean, recent: LogEntry[] | undefined): StuckReason | null {
  if (c.stuck) return c.stuck.reason;
  if (coreReportsStuck) return null;
  return recent ? assessStuck(recent, c.status) : null;
}
