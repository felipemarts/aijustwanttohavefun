import type { Appearance } from '@ajwf/appearance';
import type { Content } from '@ajwf/content';
import type { ActionName, AgentStatus, BoardTag, ClassId, ErrorCode, GameEvent, LootMode, Msg, ProfessionId, Rng } from '@ajwf/shared';
import type { TimerHeap } from './heap';
import type { Village } from './village-state';

export type Buff = { id: string; stat: 'atk' | 'def' | 'xp' | 'regen' | 'max_mp'; value: number; until: number };

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
  /** Lying defeated, waiting for a revive. Null when standing. `pvp`: felled by an agent, who already took its toll. */
  fallen: { at: number; until: number; by?: string; pvp?: true } | null;
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
  /**
   * How it entered: the room it walked out of and the exit it took, at `roomAt`. Null when it did not walk in
   * (registration, waking at the temple). One per agent: tells others where someone who just left them went.
   */
  lastExit: { room: string; dir: string } | null;

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

  /** Public standing (§7.5): rises helping others, falls betraying, stealing and scamming. May go negative. */
  honor: number;
  /** Infamy as of `infamyAt`; it decays lazily with time (see trust.ts `infamyNow`). */
  infamy: number;
  infamyAt: number;
  /** Set while the agent is Wanted: when it started, the title to give back, and when the infamy falls back under the line. */
  wanted: Wanted | null;
  /** The latest `give`s this agent made, newest last, kept for `report_scam` (bounded, within the report window). */
  gives: GiveRecord[];

  createdAt: number;
  lastActiveAt: number;
};

export type Wanted = { since: number; prev: string | null; until: number };

/** One `give`: the id of its event (what `report_scam` names), the receiver, the shop value and whether it was reported. */
export type GiveRecord = { id: string; to: string; value: number; at: number; reported?: true };

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
  /** `traitor>victim` pairs already announced as betrayals in this party (each fires once). */
  betrayed?: string[];
};

export type Guild = {
  id: string;
  name: string;
  norm: string;
  skeleton: string;
  motto: string;
  /** Language the motto was written in: the founder's `lang` at creation. Absent on guilds founded before it existed. */
  mottoLang?: string;
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
  /** Members who voted to depose the leader, in voting order. Cleared whenever the leadership changes. */
  coup: string[];
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

/** The village as a civic entity: see village-state.ts. */
export type { Village };


/** Live state of one dungeon puzzle (its rules are in puzzles.yaml). */
export type PuzzleState = {
  /** The way it guards is open until this time (0: closed). */
  open: number;
  /** levers: lever -> who pulled it and when, during the current window. */
  pulls: Record<string, { by: string; at: number }>;
  /** gate: the Warrior holding it up, and since when. */
  hold: { by: string; at: number } | null;
  /** gate: raised from the far side by the winch until this time. */
  winch: number;
  /** lock: the loot is back at this time (0: ready now). */
  ready: number;
};

/** The daily world boss: its next appearance and the instance currently in the world. */
export type WorldBoss = {
  /** When it next appears. */
  next: number;
  /** The `next` value that was already announced (each appearance is announced once). */
  announced: number;
  /** Monster uid while it is in the world, and when it leaves. */
  uid: string | null;
  leaves: number;
};

/** The wishing fountain of the village square: the coins agents toss into it (`wish`), until one of them gets them all back. */
export type Fountain = { pot: number };

/** A slow NPC that a party walks to a destination (escort quests). */
export type Escort = {
  id: string;
  quest: string;
  npc: string;
  /** Destination room. */
  to: string;
  party: string;
  /** Where the NPC stands now. */
  room: string;
  hp: number;
  max: number;
  /** Agents who accepted the quest: they lose it when the escort fails. */
  guards: string[];
  /** Last time the NPC moved (or started): a stalled escort expires. */
  at: number;
};

/** Gold escrowed on an agent's head (§7.3): whoever kills it in PvP collects it all. */
export type Bounty = {
  target: string;
  total: number;
  /** Who paid, in order of first contribution (bounded). `id` is an agent id or `@village` (mayor_bounty, `name` null). */
  by: { id: string; name: string | null; gold: number }[];
  at: number;
  /** When the refund check is due; only the timer with this exact time acts. */
  due: number;
};

/** Things that happen later. Kept in a heap; plain JSON so the heap can be snapshotted. */
export type Timer =
  | { at: number; kind: 'respawn'; room: string; slot: number }
  | { at: number; kind: 'fallen'; agent: string }
  | { at: number; kind: 'phase' }
  /** Legacy: trade expiry is swept from `trades` itself now (see trade.ts `sweepTrades`); restore drops these. */
  | { at: number; kind: 'trade'; id: string }
  /** A puzzle may close (it checks its own state: a later opening keeps it open). */
  | { at: number; kind: 'puzzle'; id: string }
  /** The world boss schedule: announce, appear, leave. */
  | { at: number; kind: 'wboss'; step: 'announce' | 'spawn' | 'leave' }
  /** A stalled escort may expire. */
  | { at: number; kind: 'escort'; id: string }
  | { at: number; kind: 'election' }
  /** An agent's infamy may have fallen back under the Wanted line. */
  | { at: number; kind: 'wanted'; agent: string }
  /** A bounty may be refunded (its target's infamy stayed at zero long enough). */
  | { at: number; kind: 'bounty'; target: string };

/** A bounded ring of events, oldest at `head`. */
export type Ring = { buf: (GameEvent | undefined)[]; head: number; size: number };

/**
 * What an agent's `GET /events` reads: the general ring (`buf`, `head`, `size`: room chatter, fights, emotes), and
 * a smaller ring of events addressed to the agent that it must not miss (whispers, trade offers, invites: see
 * `PRIORITY_EVENTS` in run.ts), so that a flood of room events cannot push them out. In memory only.
 */
export type Inbox = Ring & { pri: Ring };

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
  escortSeq: number;
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
  /** Never replaced (it marks `timers` in `dirty` itself): use `replace` to swap its content. */
  readonly timers: TimerHeap;
  inboxes: Map<string, Inbox>;
  parties: Map<string, Party>;
  guilds: Map<string, Guild>;
  /** Normalized guild name / name skeleton -> guild id. */
  guildNames: Map<string, string>;
  guildSkeletons: Map<string, string>;
  trades: Map<string, Trade>;
  /** agent id -> ids of the open trades it is part of (either side). Derived, rebuilt on restore. */
  tradesOf: Map<string, Set<string>>;
  /**
   * Party invites waiting for an answer, `<invitee id>|<inviter id>` -> expiry, in order of expiry (every invite lasts
   * `BALANCE.party.inviteMs`; a renewed one is moved to the end), so the tick finds the expired ones at the front.
   * Derived from the agents' `partyInvites`, rebuilt on restore.
   */
  inviteExpiry: Map<string, number>;
  market: Market;
  /** agent id -> ids of its open sell orders. Derived. */
  ordersOf: Map<string, Set<string>>;
  /** item id -> open orders, cheapest first. Derived. */
  ordersByItem: Map<string, Order[]>;
  /** Latest posts, oldest first (see board.ts). One snapshot entry per post: `post:<id>`. */
  board: BoardPost[];
  /** Bytes of agent text on the board (UTF-16), kept under `BALANCE.board.maxTextBytes`. Derived. */
  boardBytes: number;
  village: Village;
  /** puzzle id -> live state, one per puzzle of the content. */
  puzzles: Record<string, PuzzleState>;
  worldBoss: WorldBoss;
  fountain: Fountain;
  escorts: Map<string, Escort>;
  /** party id -> id of the escort it runs. Derived. */
  escortOfParty: Map<string, string>;
  /** room id -> ids of the escorts whose NPC stands there. Derived. */
  escortsIn: Map<string, Set<string>>;
  /** room id -> slot -> when its pending respawn is due. Derived from the timers. */
  respawns: Map<string, Map<number, number>>;
  /** target agent id -> the bounty on its head. */
  bounties: Record<string, Bounty>;
  /**
   * Keys of entities changed since the last snapshot: `agent:<id>`, `room:<id>`, `party:<id>`, `guild:<id>`, `meta`,
   * `timers` (marked by the heap itself on push and pop), `trades`, `market`, `post:<id>`, `village`, `puzzles`,
   * `wboss`, `escorts`, `bounties`, `fountain` (and `board`, the legacy entry of the whole board, exported as null once migrated). Never replaced, only cleared: the timer heap holds on to it.
   */
  readonly dirty: Set<string>;
};

export type Command = { agentId: string; action: string; params?: unknown };
/**
 * `luck`: an unpredictable roll in [0, 1), for the few rolls that pay gold from other players (the fountain's
 * jackpot). The seeded `rng` is shared by every action and its state can be recovered from visible outcomes, so a
 * patient player could time such a roll. The server passes a cryptographic source; without one (tests, the
 * simulation) those rolls fall back to `rng` and stay reproducible.
 */
export type ActionCtx = { now: number; rng: Rng; luck?: () => number };

export type ActionError = { code: ErrorCode; msg: Msg; hint?: Msg; data?: Record<string, unknown> };

export type ActionResult =
  | { ok: true; action: ActionName; narration: Msg[]; data?: Record<string, unknown> }
  | { ok: false; action: string; error: ActionError };

/** `internal`: the unexpected exception behind an `INTERNAL` refusal, for the server to log (never shown to agents). */
export type ApplyResult = { result: ActionResult; events: GameEvent[]; internal?: unknown };
