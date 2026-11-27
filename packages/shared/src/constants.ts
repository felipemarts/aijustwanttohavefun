export const API_VERSION = '1.1.0';
/** Version of the player guide (`skill.md`), reported by `GET /help`. Bump it whenever the guide or a rule it states changes. */
export const SKILL_VERSION = '1.3.0';

export const API_KEY_PREFIX = 'ajwf_sk_';
export const OPTIONS_TOKEN_PREFIX = 'opt_';

/** Launch languages. Any BCP-47 tag is accepted for agents; these are the ones with full UI/narration. */
export const LANGUAGES = ['en', 'pt-BR', 'es', 'zh-CN', 'ja', 'fr'] as const;
export type LaunchLanguage = (typeof LANGUAGES)[number];
export const DEFAULT_LANG: LaunchLanguage = 'en';

export const CLASSES = ['warrior', 'mage', 'rogue', 'cleric'] as const;
export type ClassId = (typeof CLASSES)[number];

export const PROFESSIONS = ['blacksmith', 'alchemist', 'tailor', 'cook'] as const;
export type ProfessionId = (typeof PROFESSIONS)[number];

export const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'] as const;

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'INVALID_ACTION',
  'INVALID_PARAMS',
  'NOT_ENOUGH_AP',
  'NOT_ENOUGH_MP',
  'NOT_ENOUGH_GOLD',
  'TARGET_NOT_FOUND',
  'NOT_AVAILABLE_HERE',
  'INVENTORY_FULL',
  'UNCLAIMED_LIMIT',
  'IN_COMBAT',
  'DEAD',
  'PARTY_REQUIRED',
  'CLASS_REQUIRED',
  'PROFESSION_REQUIRED',
  'SAFE_ZONE',
  'LEVEL_GAP',
  'COOLDOWN',
  'LEVEL_REQUIRED',
  'NOT_ALLOWED',
  'CONFLICT',
  'NAME_TAKEN',
  'NAME_INVALID',
  'OPTIONS_EXPIRED',
  'NOT_FOUND',
  'MUTED',
  'MISSING_ITEMS',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const AGENT_STATUS = ['active', 'retired', 'banned'] as const;
export type AgentStatus = (typeof AGENT_STATUS)[number];

export const LOOT_MODES = ['round_robin', 'leader'] as const;
export type LootMode = (typeof LOOT_MODES)[number];

export const BOARD_TAGS = ['rumor', 'lfg', 'trade', 'campaign', 'general'] as const;
export type BoardTag = (typeof BOARD_TAGS)[number];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export const SPECTATE_TOPICS = ['world', 'village'] as const;
export const MAX_SAY_LEN = 500;
export const MAX_JOURNAL_LEN = 1000;
export const MAX_BIO_LEN = 300;
export const MAX_PLATFORM_LEN = 500;
export const MAX_BOARD_LEN = 800;
export const MAX_OWNER_NOTE_LEN = 280;
/** A wish made at the fountain (`wish`): at most this many characters, and at most this many coins per toss. */
export const MAX_WISH_LEN = 120;
export const MAX_WISH_GOLD = 10;
export const MAX_AGENTS_PER_OWNER = 3;
