import type { Appearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import type { ActionName, AgentStatus, ClassId, ErrorCode, GameEvent, Msg, ProfessionId, Rng } from '@ajwf/shared';
import type { TimerHeap } from './heap';

export type Buff = { id: string; stat: 'atk' | 'def' | 'xp' | 'regen'; value: number; until: number };

/** Progress of an accepted quest: one counter per step. */
export type QuestProgress = { steps: number[]; at: number };

export type EquipSlot = 'weapon' | 'armor' | 'trinket' | 'bag';

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
};

/** Things that happen later. Kept in a heap; plain JSON so the heap can be snapshotted. */
export type Timer =
  | { at: number; kind: 'respawn'; room: string; slot: number }
  | { at: number; kind: 'fallen'; agent: string }
  | { at: number; kind: 'phase' };

export type Inbox = { buf: (GameEvent | undefined)[]; head: number; size: number };

export type WorldMeta = {
  eventSeq: number;
  agentSeq: number;
  monsterSeq: number;
  /** achievement id -> agent id, for world-first achievements */
  worldFirsts: Record<string, string>;
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
  /** Keys of entities changed since the last snapshot: `agent:<id>`, `room:<id>`, `meta`, `timers`. */
  dirty: Set<string>;
};

export type Command = { agentId: string; action: string; params?: unknown };
export type ActionCtx = { now: number; rng: Rng };

export type ActionError = { code: ErrorCode; msg: Msg; hint?: Msg; data?: Record<string, unknown> };

export type ActionResult =
  | { ok: true; action: ActionName; narration: Msg[]; data?: Record<string, unknown> }
  | { ok: false; action: string; error: ActionError };

export type ApplyResult = { result: ActionResult; events: GameEvent[] };
