import type { Appearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import type { ActionName, AgentStatus, BoardTag, ClassId, ErrorCode, GameEvent, LootMode, Msg, ProfessionId, Rng } from '@ajwf/shared';
import type { TimerHeap } from './heap';

export type Buff = { id: string; stat: 'atk' | 'def' | 'xp' | 'regen'; value: number; until: number };

/** Progress of an accepted quest: one counter per step. */
export type QuestProgress = { steps: number[]; at: number };

export type EquipSlot = 'weapon' | 'armor' | 'trinket' | 'bag';

/** Bond with another agent: score and when talking last raised it (talk is rate-limited per pair). Same on both sides. */
export type Bond = { v: number; talk: number };

/**
 * Everything about one agent. Plain JSON on purpose: this object is what gets snapshotted to Postgres.
 * HP, MP and AP are stored as of `regenAt` / `apAt` and regenerate lazily (see agent.ts `touch`).
 */
export type AgentState = {
  id: string;
  name: string;
  /** NFKC + lowercase name, the lookup key. */
  norm: string;
  /** Lookalike-folded name, used to block imitations. */
  skeleton: string;
  cls: ClassId;
  lang: string;
  bio: string;
  appearance: Appearance;
  lookHash: string;
  /** True once a human owner confirmed the claim link. */
  claimed: boolean;
  bot: boolean;
  status: AgentStatus;
  mutedUntil: number;
  ownerNote: string;

  room: string;
  level: number;
  xp: number;
  hp: number;
  mp: number;
  ap: number;
  regenAt: number;
  apAt: number;
  gold: number;
  /** item id -> quantity. Equipped items are not in here. */
  inv: Record<string, number>;
  equip: Record<EquipSlot, string | null>;
  profession: ProfessionId | null;
  buffs: Buff[];
  /** cooldown key -> timestamp when it is ready again */
  cooldowns: Record<string, number>;
  /** Lying defeated, waiting for a revive. Null when standing. */
  fallen: { at: number; until: number; by?: string } | null;
  /** Monster uid the agent is trading blows with, and until when that counts as "in combat". */
  combat: { mon: string; until: number } | null;

  quests: Record<string, QuestProgress>;
  /** quest id -> timestamp of the last completion */
  questsDone: Record<string, number>;
  /** Counters that drive achievements (see stats.ts). */
  stats: Record<string, number>;
  /** achievement id -> unlock timestamp */
  achievements: Record<string, number>;
  titles: string[];
  title: string | null;
  visited: string[];
  /** When the agent entered its current room (camaraderie needs time spent together). */
  roomAt: number;

  /** Agent ids. Mutual: each friend lists this agent too. */
  friends: string[];
  /** Agent ids this agent declared rivals (one-sided). */
  rivals: string[];
  /** Incoming friend requests: requester id -> when. */
  friendReqs: Record<string, number>;
  /** Other agent id -> bond. Only the strongest few are kept. */
  bonds: Record<string, Bond>;
  party: string | null;
  /** Incoming party invites: inviter id -> expiry. */
  partyInvites: Record<string, number>;
  guild: string | null;
  /** Incoming guild invites: guild id -> expiry. */
  guildInvites: Record<string, number>;
  /** Incoming duel challenges: challenger id -> expiry. */
  duelInvites: Record<string, number>;
  /** Journal entries written on the real day `day`. */
  journal: { day: number; n: number };

  createdAt: number;
  lastActiveAt: number;
};

export type MonsterInst = {
  uid: string;
  kind: string;
  hp: number;
  /** Index into the room's spawn list, so the same slot respawns. -1 for event spawns (world boss). */
  slot: number;
  /** agent id -> damage dealt */
  threat: Record<string, number>;
  taunt: { by: string; until: number } | null;
  lastHit: number;
};

export type ResourceNode = { qty: number; at: number };

/** Mutable part of a room. Static data (exits, flags) stays in Content. */
export type RoomState = {
  id: string;
  monsters: MonsterInst[];
  /** item id -> node */
  resources: Record<string, ResourceNode>;
  /** Items lying on the ground: item id -> quantity. */
  ground: Record<string, number>;
  /** The latest distinct speakers here, newest last (camaraderie and talk bonds). */
  said: { by: string; at: number }[];
};

export type Party = {
  id: string;
  leader: string;
  /** Agent ids in join order: the next leader is the earliest joiner. */
  members: string[];
  loot: LootMode;
  /** Round-robin cursor for drops. */
  rr: number;
  /** member id -> when it joined (bond for time spent together). */
  joined: Record<string, number>;
};

export type Guild = {
  id: string;
  name: string;
  norm: string;
  skeleton: string;
  motto: string;
  colors: [string, string];
  leader: string;
  /** In promotion order: the first is the longest-serving officer. */
  officers: string[];
  /** In join order, leader included. */
  members: string[];
  treasury: number;
  /** item id -> quantity held by the guild. */
  vault: Record<string, number>;
  createdAt: number;
};

export type Stack = { item: string; qty: number };
export type Goods = { gold: number; items: Stack[] };

/** A guaranteed trade waiting for the target's answer. Nothing is held: both sides are checked again on accept. */
export type Trade = { id: string; from: string; to: string; give: Goods; want: Goods; expires: number };

/** A market sell order. The items are held by the market (escrow) until bought or cancelled. */
export type Order = { id: string; seller: string; item: string; qty: number; price: number; at: number };
export type MarketTrade = { item: string; qty: number; price: number; buyer: string; seller: string; ts: number };
export type Market = { orders: Record<string, Order>; history: MarketTrade[] };

export type BoardReply = { by: string; text: string; at: number };
export type BoardPost = { id: string; by: string; tag: BoardTag; text: string; at: number; replies: BoardReply[] };

/** The village as a civic entity. The civic systems (mayor, projects) extend it. */
export type Village = { taxRate: number; treasury: number };


/** Things that happen later. Kept in a heap; plain JSON so the heap can be snapshotted. */
export type Timer =
  | { at: number; kind: 'respawn'; room: string; slot: number }
  | { at: number; kind: 'fallen'; agent: string }
  | { at: number; kind: 'phase' }
  | { at: number; kind: 'trade'; id: string };

export type Inbox = { buf: (GameEvent | undefined)[]; head: number; size: number };

export type WorldMeta = {
  eventSeq: number;
  agentSeq: number;
  monsterSeq: number;
  /** achievement id -> agent id, for world-first achievements */
  worldFirsts: Record<string, string>;
  partySeq: number;
  guildSeq: number;
  tradeSeq: number;
  orderSeq: number;
  postSeq: number;
  createdAt: number;
};

export type WorldState = {
  content: Content;
  meta: WorldMeta;
  agents: Map<string, AgentState>;
  /** normalized name -> agent id */
  byName: Map<string, string>;
  /** name skeleton -> agent id */
  bySkeleton: Map<string, string>;
  lookHashes: Map<string, number>;
  rooms: Map<string, RoomState>;
  /** room id -> ids of the agents standing there */
  roomAgents: Map<string, Set<string>>;
  timers: TimerHeap;
  inboxes: Map<string, Inbox>;
  parties: Map<string, Party>;
  guilds: Map<string, Guild>;
  /** Normalized guild name / name skeleton -> guild id. */
  guildNames: Map<string, string>;
  guildSkeletons: Map<string, string>;
  trades: Map<string, Trade>;
  /** agent id -> ids of the open trades it is part of (either side). Derived, rebuilt on restore. */
  tradesOf: Map<string, Set<string>>;
  market: Market;
  /** agent id -> ids of its open sell orders. Derived. */
  ordersOf: Map<string, Set<string>>;
  /** item id -> open orders, cheapest first. Derived. */
  ordersByItem: Map<string, Order[]>;
  /** Latest posts, oldest first. */
  board: BoardPost[];
  village: Village;
  /**
   * Keys of entities changed since the last snapshot: `agent:<id>`, `room:<id>`, `party:<id>`, `guild:<id>`, `meta`,
   * `timers`, `trades`, `market`, `board`, `village`.
   */
  dirty: Set<string>;
};

export type Command = { agentId: string; action: string; params?: unknown };
export type ActionCtx = { now: number; rng: Rng };

export type ActionError = { code: ErrorCode; msg: Msg; hint?: Msg; data?: Record<string, unknown> };

export type ActionResult =
  | { ok: true; action: ActionName; narration: Msg[]; data?: Record<string, unknown> }
  | { ok: false; action: string; error: ActionError };

export type ApplyResult = { result: ActionResult; events: GameEvent[] };
