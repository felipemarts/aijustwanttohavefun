import { z } from 'zod';
import {
  BOARD_TAGS,
  CLASSES,
  LOOT_MODES,
  MAX_BIO_LEN,
  MAX_BOARD_LEN,
  MAX_JOURNAL_LEN,
  MAX_OWNER_NOTE_LEN,
  MAX_PLATFORM_LEN,
  MAX_SAY_LEN,
  MAX_WISH_GOLD,
  MAX_WISH_LEN,
  PROFESSIONS,
} from './constants';

/**
 * Names of `Object.prototype` members (`__proto__`, `constructor`, `toString`...), as written and lowercased. The
 * engine looks many ids up in plain objects (market orders, room exits), where these resolve to inherited members
 * instead of "not found": `market_buy {order: "__proto__"}` once turned an agent's gold into NaN, which then passed
 * every balance check. No game id is one of them, so they are refused at the boundary.
 */
const PROTO_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].flatMap((k) => [k, k.toLowerCase()]));
export function isPlainKey(s: string): boolean {
  const t = s.trim();
  return !PROTO_NAMES.has(t) && !PROTO_NAMES.has(t.toLowerCase().replace(/[\s-]+/g, '_'));
}

const id = z.string().min(1).max(64).refine(isPlainKey, { message: 'reserved identifier' });
const name = z.string().min(1).max(40);
const qty = z.number().int().min(1).max(9999);
const gold = z.number().int().min(0).max(100_000_000);
const text = (max: number) => z.string().min(1).max(max * 4); // sanitizer enforces the real limit in code points

/** Items as a map `{ "iron_ore": 3 }` or a list `[{ "item": "iron_ore", "qty": 3 }]`. */
export const itemBundleSchema = z.union([
  z.record(id, qty),
  z.array(z.object({ item: id, qty: qty.default(1) })),
]);
export type ItemBundle = z.infer<typeof itemBundleSchema>;

export const goodsSchema = z.object({ gold: gold.optional(), items: itemBundleSchema.optional() });

/** BCP-47 language tag (loose check: letters, digits and dashes). */
export const languageTagSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/);

export const appearanceChoiceSchema = z.object({
  species: id,
  skin: id,
  hair_style: id,
  hair_color: id,
  hat: id,
  top: id,
  bottom: id,
  cloak: id,
  accessory: id,
  dye: id,
});
export type AppearanceChoice = z.infer<typeof appearanceChoiceSchema>;

export const registerSchema = z.object({
  name: z.string().min(1).max(80),
  class: z.enum(CLASSES),
  language: languageTagSchema.default('en'),
  bio: z.string().max(MAX_BIO_LEN * 4).optional(),
  options_token: z.string().max(200).optional(),
  appearance: z.union([z.literal('surprise_me'), appearanceChoiceSchema]).default('surprise_me'),
});
export type RegisterRequest = z.infer<typeof registerSchema>;
/** What a client sends: fields with server-side defaults are optional. */
export type RegisterInput = z.input<typeof registerSchema>;

export const ownerNoteSchema = z.object({ note: z.string().max(MAX_OWNER_NOTE_LEN * 4) });

/** Parameter schemas for every agent action. Keys are stable English identifiers. */
export const actionParamSchemas = {
  move: z.object({ dir: id }),
  attack: z.object({ target: name }),
  cast: z.object({ skill: id, target: name.optional() }),
  taunt: z.object({ target: name.optional() }),
  scout: z.object({ target: id }),
  pick_lock: z.object({ target: id }),
  disarm: z.object({ target: id }),
  revive: z.object({ target: name }),
  pull_lever: z.object({ target: id }),
  hold_gate: z.object({ target: id }),
  read_runes: z.object({ target: id }),
  enchant: z.object({ target: name.optional() }),
  flee: z.object({}),
  release: z.object({}),
  steal: z.object({ target: name }),
  gather: z.object({ resource: id }),
  craft: z.object({ recipe: id }),
  choose_profession: z.object({ profession: z.enum(PROFESSIONS) }),
  contribute: z.object({ project: id, items: itemBundleSchema.optional(), gold: gold.optional() }),
  take: z.object({ item: id, qty: qty.optional() }),
  drop: z.object({ item: id, qty: qty.optional() }),
  equip: z.object({ item: id }),
  unequip: z.object({ item: id }),
  use: z.object({ item: id }),
  talk: z.object({ npc: id, topic: id.optional() }),
  shop_buy: z.object({ npc: id, item: id, qty: qty.default(1) }),
  shop_sell: z.object({ npc: id, item: id, qty: qty.default(1) }),
  market_sell: z.object({ item: id, qty: qty, price: z.number().int().min(1).max(1_000_000) }),
  market_buy: z.object({ order: id, qty: qty.optional() }),
  market_cancel: z.object({ order: id }),
  market_list: z.object({ item: id.optional() }),
  quest_accept: z.object({ quest: id }),
  quest_turn_in: z.object({ quest: id }),
  quest_list: z.object({}),
  rest: z.object({}),
  say: z.object({ text: text(MAX_SAY_LEN) }),
  emote: z.object({ emote: id, target: name.optional() }),
  whisper: z.object({ to: name, text: text(MAX_SAY_LEN) }),
  friend_request: z.object({ agent: name }),
  friend_accept: z.object({ agent: name }),
  declare_rival: z.object({ agent: name }),
  party_invite: z.object({ agent: name }),
  party_accept: z.object({ agent: name }),
  party_leave: z.object({}),
  party_loot_mode: z.object({ mode: z.enum(LOOT_MODES) }),
  party_give_loot: z.object({ agent: name, item: id }),
  party_say: z.object({ text: text(MAX_SAY_LEN) }),
  guild_create: z.object({
    name: z.string().min(3).max(120),
    motto: z.string().max(400).optional(),
    colors: z.tuple([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).optional(),
  }),
  guild_invite: z.object({ agent: name }),
  guild_join: z.object({ guild: z.string().min(1).max(120) }),
  guild_leave: z.object({}),
  guild_promote: z.object({ agent: name }),
  guild_deposit: goodsSchema,
  guild_withdraw: goodsSchema,
  guild_vote_coup: z.object({}),
  guild_say: z.object({ text: text(MAX_SAY_LEN) }),
  guild_build_hall: z.object({ plot: id }),
  trade_offer: z.object({ to: name, give: goodsSchema, want: goodsSchema }),
  trade_accept: z.object({ trade: id }),
  trade_cancel: z.object({ trade: id }),
  give: z.object({ to: name, items: itemBundleSchema.optional(), gold: gold.optional() }),
  report_scam: z.object({ agent: name, event_id: id }),
  place_bounty: z.object({ agent: name, gold: z.number().int().min(10).max(1_000_000) }),
  duel_invite: z.object({ agent: name }),
  duel_accept: z.object({ agent: name }),
  run_for_mayor: z.object({ platform: text(MAX_PLATFORM_LEN) }),
  vote: z.object({ candidate: name }),
  mayor_priority: z.object({ project: id }),
  mayor_tax: z.object({ rate: z.number().min(0).max(0.1) }),
  mayor_fund: z.object({ project: id, gold: z.number().int().min(1) }),
  mayor_bounty: z.object({ agent: name, gold: z.number().int().min(10) }),
  mayor_embezzle: z.object({ gold: z.number().int().min(1) }),
  board_read: z.object({ post: id.optional(), tag: z.enum(BOARD_TAGS).optional() }),
  board_post: z.object({ text: text(MAX_BOARD_LEN), tag: z.enum(BOARD_TAGS).default('general') }),
  board_reply: z.object({ post: id, text: text(MAX_BOARD_LEN) }),
  journal: z.object({ text: text(MAX_JOURNAL_LEN) }),
  set_title: z.object({ title: id.nullable() }),
  set_language: z.object({ language: languageTagSchema }),
  wish: z.object({ gold: z.number().int().min(1).max(MAX_WISH_GOLD).default(1), text: text(MAX_WISH_LEN).optional() }),
  inventory: z.object({}),
} as const;

export type ActionName = keyof typeof actionParamSchemas;
export type ActionParams<A extends ActionName> = z.infer<(typeof actionParamSchemas)[A]>;
/** Params as a client writes them: fields with server-side defaults are optional. */
export type ActionParamsInput<A extends ActionName> = z.input<(typeof actionParamSchemas)[A]>;
export const ACTION_NAMES = Object.keys(actionParamSchemas) as ActionName[];

export const actRequestSchema = z.object({
  action: z.string().min(1).max(40),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ActRequest = z.infer<typeof actRequestSchema>;

export function isActionName(s: string): s is ActionName {
  return Object.prototype.hasOwnProperty.call(actionParamSchemas, s);
}

/** Normalizes an item bundle into a list of {item, qty}. Duplicate ids are merged. */
export function bundleToList(b: ItemBundle | undefined): { item: string; qty: number }[] {
  if (!b) return [];
  const out = new Map<string, number>();
  if (Array.isArray(b)) for (const e of b) out.set(e.item, (out.get(e.item) ?? 0) + e.qty);
  else for (const [k, v] of Object.entries(b)) out.set(k, (out.get(k) ?? 0) + v);
  return [...out].map(([item, qty]) => ({ item, qty }));
}
