/** Secrets Revealed: merging pages and turning a conversation into a chat thread. Pure. */
import type { SecretConversation, SecretMessage } from '@ajwf/shared';

/** Adds a page to what is shown: deduplicated by id (a later copy wins), newest conversation first. */
export function mergeSecretPages(have: readonly SecretConversation[], page: readonly SecretConversation[]): SecretConversation[] {
  const byId = new Map<string, SecretConversation>();
  for (const c of have) byId.set(c.id, c);
  for (const c of page) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, c);
      continue;
    }
    // The same conversation split across two pages: join its messages.
    const msgs = new Map<string, SecretMessage>();
    for (const m of [...prev.messages, ...c.messages]) msgs.set(m.id, m);
    const messages = [...msgs.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    byId.set(c.id, {
      ...prev,
      agents: [...new Set([...prev.agents, ...c.agents])],
      from: Math.min(prev.from, c.from),
      to: Math.max(prev.to, c.to),
      messages,
    });
  }
  return [...byId.values()].sort((a, b) => b.to - a.to || b.id.localeCompare(a.id));
}

export type ThreadGroup = {
  from: string;
  /** Whispers: the first speaker on the start side, the other on the end side. Group chats: all on the start side. */
  side: 'start' | 'end';
  /** Stable colour slot of the speaker within the conversation (0..5). */
  slot: number;
  messages: SecretMessage[];
};

/** Consecutive messages of the same speaker grouped into one bubble run, oldest first. */
export function threadOf(c: SecretConversation): ThreadGroup[] {
  const speakers: string[] = [];
  const out: ThreadGroup[] = [];
  const sorted = [...c.messages].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  for (const m of sorted) {
    if (!speakers.includes(m.from)) speakers.push(m.from);
    const slot = speakers.indexOf(m.from) % 6;
    const last = out[out.length - 1];
    if (last && last.from === m.from && m.ts - last.messages[last.messages.length - 1]!.ts < 10 * 60_000) {
      last.messages.push(m);
      continue;
    }
    out.push({ from: m.from, side: c.channel === 'whisper' && slot % 2 === 1 ? 'end' : 'start', slot, messages: [m] });
  }
  return out;
}

/** Who took part, speakers first in order of speaking, then the silent recipients. */
export function participants(c: SecretConversation): string[] {
  const out: string[] = [];
  for (const m of c.messages) if (!out.includes(m.from)) out.push(m.from);
  for (const a of c.agents) if (!out.includes(a)) out.push(a);
  return out;
}
