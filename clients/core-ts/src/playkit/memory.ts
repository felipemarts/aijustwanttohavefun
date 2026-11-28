/** Memory, the world map and chat with the owner (README 5, 7; Go: `memory.go`, `world.go`). */
import { arr, formatNumber, get, has, isObj, obj, text, type JObj, type JV } from './jv.ts';
import type { Kit } from './kit.ts';
import { str } from './read.ts';
import { chatBlock, notesBlock, recentBlock, statusBlock, systemPromptValues } from './prompt.ts';
import { clip, plain, render, trimSpace } from './text.ts';
import { extract, validateSchema } from './decide.ts';
import type { ChatInput, ChatLine, GameErr, Memory, Message, QuestTold, Recent } from './types.ts';

export { observe, worldPath } from './world.ts';

/** README 5.1: agent-written lines to the chat buffer, game texts to the events. */
export function heard(messages: JV | undefined): { chat: ChatLine[]; events: string[] } {
  const chat: ChatLine[] = [];
  const events: string[] = [];
  for (const m of arr(messages)) {
    const kind = str(m, 'kind');
    if (has(m, 'untrusted_text')) {
      chat.push({ from: str(m, 'from'), kind, text: text(get(m, 'untrusted_text')) });
      continue;
    }
    const t = str(m, 'text');
    if (t !== '') events.push(t);
  }
  return { chat, events };
}

/** README 5.2. Returns true when the notes need compaction. */
export function remember(kit: Kit, m: Memory, r: Recent | null, note: string, chat: ChatLine[]): boolean {
  if (r && r.ok && r.action === 'quest_accept') {
    const id = str(r.params, 'quest');
    if (id !== '') {
      let kept: QuestTold[] = m.told.filter((t) => t.quest !== id);
      kept.push({ quest: id, text: plain(r.text, kit.lim('questText')) });
      const n = kit.lim('questsTold');
      if (kept.length > n) kept = kept.slice(kept.length - n);
      m.told = kept;
    }
  }
  if (r) {
    m.recent = [...m.recent, { ...r, text: plain(r.text, kit.lim('recentText')) }];
    const n = kit.lim('recent');
    if (m.recent.length > n) m.recent = m.recent.slice(m.recent.length - n);
  }
  m.chat = [...m.chat, ...chat];
  const nc = kit.lim('chat');
  if (m.chat.length > nc) m.chat = m.chat.slice(m.chat.length - nc);
  if (r && m.noteWait > 0) m.noteWait--;
  else {
    const n = plain(note, kit.config.decision.noteMax);
    if (n !== '' && !m.notes.includes(n)) {
      m.notes = [...m.notes, n];
      m.noteWait = kit.lim('noteEvery');
    }
  }
  return m.notes.length > kit.lim('notes');
}

/** The `recent` entry of an outcome: the narration when it went through, else "<code>: <message>". */
export function recentOf(action: string, params: JV, ok: boolean, narration: string, e?: GameErr): Recent {
  return { action, params: isObj(params) ? params : obj(), ok, text: !ok && e ? `${e.code}: ${e.message}` : narration };
}

export function compactionSchema(kit: Kit): JObj {
  const max = kit.lim('notesAfterCompaction');
  const item = obj(['type', 'string'], ['maxLength', kit.config.decision.noteMax]);
  const notes = obj(['type', 'array'], ['items', item], ['maxItems', max]);
  return obj(['type', 'object'], ['properties', obj(['notes', notes])], ['required', ['notes']], ['additionalProperties', false]);
}

/** README 5.4: the messages and schema that merge notes. */
export function compactionTurn(kit: Kit, name: string, notes: string[]): { messages: Message[]; schema: JObj } {
  const content = render(kit.templates.compact, {
    name: plain(name, kit.lim('nameText')),
    max: formatNumber(kit.lim('notesAfterCompaction')),
    len: formatNumber(kit.config.decision.noteMax),
    notes: notes.map((n) => `- ${plain(n, kit.config.decision.noteMax)}`).join('\n'),
  });
  return { messages: [{ role: 'user', content }], schema: compactionSchema(kit) };
}

/** The compaction answer's notes, or, on any problem, the newest `notes`. */
export function applyCompaction(kit: Kit, raw: string, notes: string[]): string[] {
  const n = kit.lim('notes');
  const cut = () => (notes.length > n ? notes.slice(notes.length - n) : notes);
  const e = extract(kit, raw);
  if ('problem' in e) return cut();
  if (validateSchema(e.value, compactionSchema(kit), 'answer') !== '') return cut();
  const out: string[] = [];
  for (const x of arr(get(e.value, 'notes'))) {
    const p = plain(text(x), kit.config.decision.noteMax);
    if (p !== '' && !out.includes(p)) out.push(p);
  }
  return out.length ? out : cut();
}

/** README 7: a reply to the owner; free text, never an action. */
export function chatTurn(kit: Kit, input: ChatInput): Message[] {
  let status = statusBlock(kit, input.character, input.observation, input.me);
  const room = get(input.observation, 'room');
  if (has(input.observation, 'room')) status += `\nPlace: ${plain(str(room, 'name'), 80)} (${str(room, 'id')}).`;
  const sys = render(kit.templates.chat, {
    ...systemPromptValues(kit, input.character, input.observation),
    status,
    notes: notesBlock(kit, input.memory.notes),
    recent: recentBlock(kit, input.memory.recent),
    chat: chatBlock(kit, input.memory.chat),
  });
  const n = kit.lim('chatHistory');
  const hist = input.history.length > n ? input.history.slice(input.history.length - n) : input.history;
  const limit = kit.lim('ownerText');
  return [
    { role: 'system', content: sys },
    ...hist.map((h): Message => ({ role: h.from === 'character' ? 'assistant' : 'user', content: clip(trimSpace(h.text), limit) })),
    { role: 'user', content: clip(trimSpace(input.text), limit) },
  ];
}
