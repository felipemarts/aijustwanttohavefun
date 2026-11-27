import { MAX_SAY_LEN, own } from '@ajwf/shared';
import { bump } from '../agent';
import { BALANCE } from '../balance';
import { noteSpeech } from '../camaraderie';
import { questEvent } from '../quests';
import { WANTED_TITLE, wantedHours } from '../trust';
import { emit, fail, msg, tell, type Run } from '../run';
import type { AgentState } from '../types';
import { agentByName, agentHere, cleanText, normId, type HandlerMap } from './util';

const DAY = 24 * 60 * 60 * 1000;
/** Whispers and private chats become public this long after being sent (PLANEJAMENTO §7.6). */
export const REVEAL_AFTER_MS = DAY;

/**
 * One message every few seconds per agent, across all chat channels. Checked before the text is cleaned (the
 * sanitizer is the expensive part of a chat action, and a refusal must cost the server as little as possible), and
 * started only once the text passed, so a refused message changes nothing.
 */
export function checkChatCooldown(run: Run, a: AgentState): void {
  const readyAt = own(a.cooldowns, 'say') ?? 0;
  if (readyAt > run.now) fail('COOLDOWN', 'chat_cooldown', { seconds: Math.ceil((readyAt - run.now) / 1000) });
}

export function startChatCooldown(run: Run, a: AgentState): void {
  a.cooldowns.say = run.now + BALANCE.chat.sayCooldownMs;
}

/** Cooldown first, then the text: the cleaned text, with the cooldown started. */
export function chatText(run: Run, a: AgentState, raw: string, max: number, multiline = false): string {
  checkChatCooldown(run, a);
  const text = cleanText(raw, max, multiline);
  startChatCooldown(run, a);
  return text;
}

export const chatActions: HandlerMap = {
  say(run, a, p) {
    const text = chatText(run, a, p.text, MAX_SAY_LEN);
    tell(run, 'n.say');
    emit(run, 'say', { room: a.room, actor: a.id, to: 'room', lang: a.lang, drama: 1, data: { text } });
    bump(run, a, 'says');
    questEvent(run, a, 'say');
    noteSpeech(run, a);
  },

  whisper(run, a, p) {
    const b = agentByName(run, p.to);
    if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name: p.to });
    if (b === a) fail('INVALID_PARAMS', 'not_yourself');
    const text = chatText(run, a, p.text, MAX_SAY_LEN);
    tell(run, 'n.whisper', { name: b.name });
    emit(run, 'whisper', {
      room: a.room,
      actor: a.id,
      target: b.id,
      vis: 'delayed',
      revealAt: run.now + REVEAL_AFTER_MS,
      to: [b.id],
      lang: a.lang,
      data: { text },
    });
    bump(run, a, 'whispers');
  },

  emote(run, a, p) {
    const id = normId(p.emote);
    if (!run.c.emotes.has(id)) fail('TARGET_NOT_FOUND', 'emote_unknown', { emote: p.emote, emotes: [...run.c.emotes.keys()].join(', ') });
    const b = p.target ? agentHere(run, a, p.target) : null;
    const m = b ? msg(`content.emote.${id}.at`, { actor: a.name, target: b.name }) : msg(`content.emote.${id}.solo`, { actor: a.name });
    run.narr.push(m);
    // Emotes cost nothing: past one every `emoteInboxMs`, they are still seen (spectators, the room log) but no
    // longer delivered to inboxes, so a flood of them cannot bury what other agents need to read.
    const deliver = (own(a.cooldowns, 'emote') ?? 0) <= run.now;
    if (deliver) a.cooldowns.emote = run.now + BALANCE.chat.emoteInboxMs;
    emit(run, 'emote', { room: a.room, actor: a.id, ...(b ? { target: b.id } : {}), to: deliver ? 'room' : 'none', m, data: { emote: id } });
    questEvent(run, a, 'emote', id);
  },

  set_language(run, a, p) {
    a.lang = p.language;
    tell(run, 'n.language_set', { language: p.language });
  },

  set_title(run, a, p) {
    const id = p.title === null ? null : normId(p.title);
    if (id !== null && !a.titles.includes(id)) fail('TARGET_NOT_FOUND', 'title_not_owned', { title: p.title ?? '', titles: a.titles.join(', ') });
    // A Wanted agent wears that title until its infamy fades; the one it had comes back then.
    if (a.wanted && id !== WANTED_TITLE) fail('NOT_ALLOWED', 'title_wanted', { hours: wantedHours(a, run.now) });
    a.title = id;
    tell(run, id ? 'n.title_set' : 'n.title_cleared', id ? { title: `@title:${id}` } : undefined);
    emit(run, 'title', { room: a.room, actor: a.id, vis: 'public', data: { title: id } });
  },
};
