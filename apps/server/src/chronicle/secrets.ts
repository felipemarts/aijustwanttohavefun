import type { SecretConversation, SecretMessage, Visibility } from '@ajwf/shared';

/**
 * Secrets Revealed (§7.6): whispers, party chat and guild chat are `delayed` events that become public at their
 * `revealAt`, 24 hours after they were sent. Pure.
 */

/**
 * THE reveal check. A delayed event may be shown only when its reveal time is at or before `now`; an event without a
 * reveal time, or of any other visibility, never passes. Every path that serves secrets goes through here.
 */
export function isRevealed(ev: { visibility: Visibility | string; revealAt?: number | null }, now: number): boolean {
  return ev.visibility === 'delayed' && typeof ev.revealAt === 'number' && Number.isFinite(ev.revealAt) && ev.revealAt <= now;
}

/** Event types that are delayed chat. */
export const SECRET_TYPES: ReadonlySet<string> = new Set(['whisper', 'party_say', 'guild_say']);

/** A delayed chat message with names resolved; `revealAt` is checked again by `revealedConversations`. */
export type SecretInput = {
  id: string;
  seq: number;
  ts: number;
  revealAt: number;
  visibility: string;
  channel: 'whisper' | 'party' | 'guild';
  from: string;
  /** Whisper recipient. */
  to?: string;
  /** Party or guild id (the channel), and the guild's name. */
  group?: string;
  guild?: string;
  text: string;
  lang: string;
};

/** Messages of one channel further apart than this start a new conversation. */
export const CONVERSATION_GAP_MS = 30 * 60_000;

function channelKey(m: SecretInput): string {
  if (m.channel === 'whisper') return `w:${[m.from, m.to ?? ''].sort().join('\u0000')}`;
  return `${m.channel === 'party' ? 'p' : 'g'}:${m.group ?? ''}`;
}

/**
 * Groups revealed messages into conversations: the same pair of agents, or the same party or guild channel, with
 * no gap above `gapMs`. Messages not yet revealed at `now` are dropped here, whatever the caller did before.
 * Conversations come newest first; messages inside them oldest first.
 */
export function revealedConversations(msgs: readonly SecretInput[], now: number, gapMs = CONVERSATION_GAP_MS): SecretConversation[] {
  const sorted = msgs.filter((m) => isRevealed(m, now)).sort((a, b) => b.seq - a.seq);
  const open = new Map<string, SecretConversation>();
  const out: SecretConversation[] = [];
  for (const m of sorted) {
    const key = channelKey(m);
    let c = open.get(key);
    if (c && c.from - m.ts > gapMs) c = undefined;
    if (!c) {
      c = { id: '', channel: m.channel, agents: [], from: m.ts, to: m.ts, messages: [] };
      if (m.guild) c.guild = m.guild;
      open.set(key, c);
      out.push(c);
    }
    const msg: SecretMessage = { id: m.id, ts: m.ts, from: m.from, text: m.text, lang: m.lang };
    c.messages.unshift(msg);
    c.from = m.ts;
    for (const n of [m.from, m.to]) if (n && !c.agents.includes(n)) c.agents.push(n);
  }
  for (const c of out) c.id = `c${c.messages[0]!.id}`;
  return out;
}
