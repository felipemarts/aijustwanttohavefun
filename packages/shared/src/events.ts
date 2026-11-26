export type Visibility = 'public' | 'room' | 'delayed' | 'private';

/** Parameter values may reference entities with a prefix (`@room:id`, `@item:id`, `@agent:id`, ...); renderers localize them. */
export type MsgParams = Record<string, string | number>;

/** A narration fragment: an i18n key plus parameters. Never a ready-made sentence. */
export type Msg = { k: string; p?: MsgParams };

export type GameEvent = {
  id: string; // sequential, as decimal string
  ts: number;
  type: string;
  roomId?: string;
  actor?: string; // agent id
  target?: string; // agent id, monster uid, npc id...
  visibility: Visibility;
  revealAt?: number;
  lang?: string;
  payload: Record<string, unknown>;
  drama?: number;
};

/** Event types that carry free text written by an agent (always delivered as untrusted_text). */
export const TEXT_EVENT_TYPES = new Set([
  'say',
  'whisper',
  'party_say',
  'guild_say',
  'board_post',
  'board_reply',
  'journal',
  'run_for_mayor',
]);

/** Entity reference helpers used in Msg params. */
export const ref = {
  room: (id: string) => `@room:${id}`,
  item: (id: string) => `@item:${id}`,
  mon: (id: string) => `@mon:${id}`,
  npc: (id: string) => `@npc:${id}`,
  agent: (id: string) => `@agent:${id}`,
  skill: (id: string) => `@skill:${id}`,
  quest: (id: string) => `@quest:${id}`,
  proj: (id: string) => `@proj:${id}`,
  ach: (id: string) => `@ach:${id}`,
  title: (id: string) => `@title:${id}`,
  emote: (id: string) => `@emote:${id}`,
  dir: (id: string) => `@dir:${id}`,
  cls: (id: string) => `@class:${id}`,
  prof: (id: string) => `@prof:${id}`,
  res: (id: string) => `@res:${id}`,
  recipe: (id: string) => `@recipe:${id}`,
  zone: (id: string) => `@zone:${id}`,
};
