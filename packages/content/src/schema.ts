import { z } from 'zod';
import { CLASSES, PROFESSIONS, RARITIES } from '@ajwf/shared';

const id = z.string().regex(/^[a-z0-9_.]+$/, 'ids are lowercase ascii, digits, "_" and "."');
const stack = z.object({ item: id, qty: z.number().int().min(1).default(1) });
const stats = z
  .object({
    atk: z.number().default(0),
    def: z.number().default(0),
    str: z.number().default(0),
    int: z.number().default(0),
    agi: z.number().default(0),
    vit: z.number().default(0),
  })
  .partial();

export const zoneSchema = z.object({
  id,
  law: z.enum(['safe', 'lawless', 'group']),
  level: z.tuple([z.number().int(), z.number().int()]),
});

export const roomSchema = z.object({
  id,
  zone: id,
  level: z.number().int().min(0).max(20).default(0),
  flags: z.array(z.enum(['safe', 'lawless', 'dungeon', 'plot', 'tavern', 'temple', 'market', 'training', 'town_hall', 'guild_hall', 'arena', 'board', 'station'])).default([]),
  exits: z.record(z.string(), id),
  rect: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  monsters: z.array(z.object({ id, count: z.number().int().min(1).default(1), night: z.boolean().optional() })).default([]),
  resources: z.array(z.object({ id, max: z.number().int().min(1), regen_per_hour: z.number().min(0) })).default([]),
  /** Exits that need something before they open: a project, a puzzle, a party. */
  gates: z
    .record(
      z.string(),
      z.object({
        requires: z.enum(['project', 'puzzle', 'party', 'boss']),
        id: id.optional(),
      }),
    )
    .default({}),
  stations: z.array(z.enum(['forge', 'alchemy', 'loom', 'kitchen'])).default([]),
});

export const monsterSchema = z.object({
  id,
  level: z.number().int().min(1).max(25),
  hp: z.number().int().min(1),
  atk: z.number().min(0),
  def: z.number().min(0),
  xp: z.number().int().min(0),
  gold: z.tuple([z.number().int(), z.number().int()]),
  drops: z.array(z.object({ item: id, chance: z.number().min(0).max(1), qty: z.number().int().min(1).default(1) })).default([]),
  respawn_sec: z.number().int().min(5).default(120),
  boss: z.boolean().default(false),
  world_boss: z.boolean().default(false),
  /** Damage dealt to every agent in the room each round (boss mechanic). */
  aoe: z.number().min(0).default(0),
  /** Extra multiplier against a lone attacker (kills soloers). */
  solo_crush: z.number().min(1).default(1),
  /** Group bosses: while fewer agents than this fight it, it shrugs off most of the damage. */
  min_group: z.number().int().min(1).default(1),
  elite: z.boolean().default(false),
});

export const itemSchema = z.object({
  id,
  type: z.enum(['weapon', 'armor', 'trinket', 'consumable', 'food', 'material', 'cosmetic', 'tool', 'bag', 'quest', 'dye']),
  rarity: z.enum(RARITIES).default('common'),
  value: z.number().int().min(0),
  level: z.number().int().min(1).max(20).default(1),
  classes: z.array(z.enum(CLASSES)).optional(),
  stats: stats.optional(),
  stackable: z.boolean().optional(),
  effect: z
    .object({
      heal: z.number().optional(),
      mp: z.number().optional(),
      buff: z.object({ id, stat: z.enum(['atk', 'def', 'xp', 'regen']), value: z.number(), minutes: z.number() }).optional(),
    })
    .optional(),
  /** Cosmetic items unlock an appearance option for a layer. */
  cosmetic: z.object({ layer: z.enum(['hat', 'top', 'bottom', 'cloak', 'accessory', 'dye', 'hair_style', 'hair_color']), option: id }).optional(),
  bag_slots: z.number().int().min(1).optional(),
});

export const recipeSchema = z.object({
  id,
  profession: z.enum(PROFESSIONS),
  level: z.number().int().min(1).default(5),
  station: z.enum(['forge', 'alchemy', 'loom', 'kitchen']),
  inputs: z.array(stack).min(1),
  output: stack,
});

export const npcSchema = z.object({
  id,
  room: id,
  roles: z.array(z.enum(['shop', 'quest', 'guard', 'priest', 'innkeeper', 'clerk', 'trainer', 'escort'])),
  shop: id.optional(),
  topics: z.array(id).default([]),
});

export const shopSchema = z.object({
  id,
  sells: z.array(z.object({ item: id, price: z.number().int().min(1) })),
  /** Fraction of item value paid when buying from agents. */
  buy_rate: z.number().min(0).max(1).default(0.4),
  buys: z.array(z.enum(['weapon', 'armor', 'trinket', 'consumable', 'food', 'material', 'cosmetic', 'tool', 'bag', 'dye'])).default([]),
});

export const questStepSchema = z.object({
  type: z.enum([
    'kill', 'collect', 'deliver', 'visit', 'escort', 'craft', 'gather', 'party', 'trade', 'mentor', 'contribute',
    'vote', 'talk', 'say', 'friend', 'equip', 'board_post', 'journal', 'shop_buy', 'level', 'help_newbie', 'puzzle', 'boss',
    'profession', 'market', 'rest', 'emote', 'guild', 'duel',
  ]),
  target: id.optional(),
  qty: z.number().int().min(1).default(1),
});

export const questSchema = z.object({
  id,
  kind: z.enum(['tutorial', 'daily', 'chain', 'side', 'escort']),
  giver: id,
  level: z.number().int().min(1).default(1),
  requires: id.optional(),
  steps: z.array(questStepSchema).min(1),
  /** Items handed to the agent on accept (letters to deliver and the like). */
  grants: z.array(stack).default([]),
  /** Items consumed on turn-in (deliver/collect). */
  consume: z.array(stack).default([]),
  rewards: z.object({ xp: z.number().int().min(0), gold: z.number().int().min(0).default(0), items: z.array(stack).default([]) }),
  social: z.boolean().default(false),
  party_min: z.number().int().min(1).default(1),
  /** Escort quests: npc that follows and the room it must reach. */
  escort: z.object({ npc: id, to: id }).optional(),
});

export const achievementSchema = z.object({
  id,
  stat: z.string().min(1),
  gte: z.number().min(0),
  title: id.optional(),
  world_first: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

export const titleSchema = z.object({ id, prefix: z.boolean().default(true) });

export const classSchema = z.object({
  id: z.enum(CLASSES),
  base: z.object({ str: z.number(), int: z.number(), agi: z.number(), vit: z.number() }),
  per_level: z.object({ str: z.number(), int: z.number(), agi: z.number(), vit: z.number() }),
  primary: z.enum(['str', 'int', 'agi']),
  skills: z.array(id).length(4),
  starter: z.array(stack).default([]),
});

export const skillSchema = z.object({
  id,
  class: z.enum(CLASSES),
  level: z.number().int().min(1).max(20),
  mp: z.number().int().min(0),
  kind: z.enum(['damage', 'aoe', 'heal', 'party_heal', 'revive', 'buff', 'taunt', 'shield', 'escape']),
  power: z.number().min(0),
  target: z.enum(['enemy', 'ally', 'self', 'party', 'room']),
  cooldown_sec: z.number().int().min(0).default(0),
  buff: z.object({ stat: z.enum(['atk', 'def']), value: z.number(), minutes: z.number() }).optional(),
});

export const projectSchema = z.object({
  id,
  site: id,
  cost: z.object({ gold: z.number().int().min(0), items: z.array(stack).default([]) }),
  requires: z.array(id).default([]),
  unlocks: z.array(z.string()).default([]),
  /** Building sprite kind for the map renderer. */
  building: z.string(),
});

export const puzzleSchema = z.object({
  id,
  room: id,
  type: z.enum(['levers', 'seal', 'trap', 'gate', 'lock']),
  targets: z.array(id).min(1),
  window_sec: z.number().int().min(1).default(60),
  open_sec: z.number().int().min(1).default(120),
  reset_sec: z.number().int().min(1).default(900),
  damage: z.number().int().min(0).default(0),
  loot: z.array(stack).default([]),
  /** Gate puzzles: a room on the far side where a winch (pull_lever) reopens the gate. */
  winch_room: id.optional(),
});

export const professionSchema = z.object({ id: z.enum(PROFESSIONS), station: z.enum(['forge', 'alchemy', 'loom', 'kitchen']) });
export const emoteSchema = z.object({ id });
export const gazetteTemplatesSchema = z.record(z.string(), z.number().int().min(1));

export const contentSchemas = {
  zones: z.array(zoneSchema),
  rooms: z.array(roomSchema),
  monsters: z.array(monsterSchema),
  items: z.array(itemSchema),
  recipes: z.array(recipeSchema),
  professions: z.array(professionSchema),
  npcs: z.array(npcSchema),
  shops: z.array(shopSchema),
  quests: z.array(questSchema),
  achievements: z.array(achievementSchema),
  titles: z.array(titleSchema),
  classes: z.array(classSchema),
  skills: z.array(skillSchema),
  emotes: z.array(emoteSchema),
  projects: z.array(projectSchema),
  puzzles: z.array(puzzleSchema),
  gazette_templates: gazetteTemplatesSchema,
} as const;

export type Zone = z.infer<typeof zoneSchema>;
export type Room = z.infer<typeof roomSchema>;
export type Monster = z.infer<typeof monsterSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Npc = z.infer<typeof npcSchema>;
export type Shop = z.infer<typeof shopSchema>;
export type Quest = z.infer<typeof questSchema>;
export type QuestStep = z.infer<typeof questStepSchema>;
export type Achievement = z.infer<typeof achievementSchema>;
export type Title = z.infer<typeof titleSchema>;
export type ClassDef = z.infer<typeof classSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Puzzle = z.infer<typeof puzzleSchema>;
export type Profession = z.infer<typeof professionSchema>;
export type Emote = z.infer<typeof emoteSchema>;
