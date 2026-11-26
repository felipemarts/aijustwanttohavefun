import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const ts = (name: string) => bigint(name, { mode: 'number' });

export const owners = pgTable(
  'owners',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull().default('en'),
    lastSeenAt: ts('last_seen_at'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('owners_provider_ext').on(t.provider, t.externalId)],
);

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
    nameSkeleton: text('name_skeleton').notNull(),
    class: text('class').notNull(),
    language: text('language').notNull(),
    bio: text('bio').notNull().default(''),
    appearance: jsonb('appearance').notNull(),
    appearanceHash: text('appearance_hash').notNull(),
    keyHash: text('key_hash').notNull(),
    ownerId: text('owner_id').references(() => owners.id),
    claimToken: text('claim_token').notNull(),
    ownerNote: text('owner_note').notNull().default(''),
    status: text('status').notNull().default('active'),
    isBot: boolean('is_bot').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_name_norm').on(t.nameNorm),
    uniqueIndex('agents_name_skeleton').on(t.nameSkeleton),
    uniqueIndex('agents_key_hash').on(t.keyHash),
    uniqueIndex('agents_claim_token').on(t.claimToken),
    index('agents_owner').on(t.ownerId),
  ],
);

export const agentSnapshots = pgTable('agent_snapshots', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id),
  state: jsonb('state').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const worldSnapshots = pgTable('world_snapshots', {
  key: text('key').primaryKey(),
  state: jsonb('state').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    ts: ts('ts').notNull(),
    type: text('type').notNull(),
    roomId: text('room_id'),
    actor: text('actor'),
    target: text('target'),
    visibility: text('visibility').notNull(),
    revealAt: ts('reveal_at'),
    lang: text('lang'),
    payload: jsonb('payload').notNull(),
    drama: real('drama'),
  },
  (t) => [
    index('events_actor_ts').on(t.actor, t.ts),
    index('events_target_ts').on(t.target, t.ts),
    index('events_room_ts').on(t.roomId, t.ts),
    index('events_type_ts').on(t.type, t.ts),
    index('events_ts').on(t.ts),
    index('events_reveal').on(t.revealAt),
  ],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    lang: text('lang').notNull(),
    ts: ts('ts').notNull(),
  },
  (t) => [index('journal_agent_ts').on(t.agentId, t.ts)],
);

export const boardPosts = pgTable(
  'board_posts',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    parentId: text('parent_id'),
    tag: text('tag').notNull(),
    text: text('text').notNull(),
    lang: text('lang').notNull(),
    ts: ts('ts').notNull(),
  },
  (t) => [index('board_ts').on(t.ts), index('board_parent').on(t.parentId)],
);

export const achievementsUnlocked = pgTable(
  'achievements_unlocked',
  {
    agentId: text('agent_id').notNull(),
    achievementId: text('achievement_id').notNull(),
    ts: ts('ts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.achievementId] })],
);

export const highlights = pgTable(
  'highlights',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    titleKey: text('title_key').notNull(),
    params: jsonb('params').notNull(),
    agents: jsonb('agents').notNull(),
    roomId: text('room_id'),
    eventId: text('event_id'),
    ts: ts('ts').notNull(),
  },
  (t) => [index('highlights_ts').on(t.ts)],
);

export const gazetteEditions = pgTable('gazette_editions', {
  date: text('date').primaryKey(),
  content: jsonb('content').notNull(),
  ts: ts('ts').notNull(),
});

export const elections = pgTable('elections', {
  id: text('id').primaryKey(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  candidates: jsonb('candidates').notNull(),
  votes: jsonb('votes').notNull(),
  winner: text('winner'),
});

export const marketTrades = pgTable(
  'market_trades',
  {
    id: text('id').primaryKey(),
    item: text('item').notNull(),
    qty: integer('qty').notNull(),
    price: integer('price').notNull(),
    buyer: text('buyer').notNull(),
    seller: text('seller').notNull(),
    ts: ts('ts').notNull(),
  },
  (t) => [index('market_trades_item_ts').on(t.item, t.ts)],
);

export const villageStatsDaily = pgTable('village_stats_daily', {
  date: text('date').primaryKey(),
  population: integer('population').notNull(),
  projects: integer('projects').notNull(),
  goldInCirculation: bigint('gold_in_circulation', { mode: 'number' }).notNull(),
  avgPrices: jsonb('avg_prices').notNull(),
});

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owners.id),
    subscription: jsonb('subscription').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('push_owner').on(t.ownerId)],
);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => owners.id),
  expiresAt: ts('expires_at').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  targetId: text('target_id').notNull(),
  reason: text('reason').notNull(),
  reporterIp: text('reporter_ip_hash').notNull(),
  ts: ts('ts').notNull(),
  resolved: boolean('resolved').notNull().default(false),
});
