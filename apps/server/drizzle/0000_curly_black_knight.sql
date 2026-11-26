CREATE TABLE "achievements_unlocked" (
	"agent_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"ts" bigint NOT NULL,
	CONSTRAINT "achievements_unlocked_agent_id_achievement_id_pk" PRIMARY KEY("agent_id","achievement_id")
);
--> statement-breakpoint
CREATE TABLE "agent_snapshots" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"name_skeleton" text NOT NULL,
	"class" text NOT NULL,
	"language" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"appearance" jsonb NOT NULL,
	"appearance_hash" text NOT NULL,
	"key_hash" text NOT NULL,
	"owner_id" text,
	"claim_token" text NOT NULL,
	"owner_note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"parent_id" text,
	"tag" text NOT NULL,
	"text" text NOT NULL,
	"lang" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"candidates" jsonb NOT NULL,
	"votes" jsonb NOT NULL,
	"winner" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"type" text NOT NULL,
	"room_id" text,
	"actor" text,
	"target" text,
	"visibility" text NOT NULL,
	"reveal_at" bigint,
	"lang" text,
	"payload" jsonb NOT NULL,
	"drama" real
);
--> statement-breakpoint
CREATE TABLE "gazette_editions" (
	"date" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"agents" jsonb NOT NULL,
	"room_id" text,
	"event_id" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"text" text NOT NULL,
	"lang" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"qty" integer NOT NULL,
	"price" integer NOT NULL,
	"buyer" text NOT NULL,
	"seller" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"last_seen_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"subscription" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"reporter_ip_hash" text NOT NULL,
	"ts" bigint NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "village_stats_daily" (
	"date" text PRIMARY KEY NOT NULL,
	"population" integer NOT NULL,
	"projects" integer NOT NULL,
	"gold_in_circulation" bigint NOT NULL,
	"avg_prices" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_snapshots" (
	"key" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_snapshots" ADD CONSTRAINT "agent_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_norm" ON "agents" USING btree ("name_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_skeleton" ON "agents" USING btree ("name_skeleton");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_key_hash" ON "agents" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_claim_token" ON "agents" USING btree ("claim_token");--> statement-breakpoint
CREATE INDEX "agents_owner" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "board_ts" ON "board_posts" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "board_parent" ON "board_posts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "events_actor_ts" ON "events" USING btree ("actor","ts");--> statement-breakpoint
CREATE INDEX "events_target_ts" ON "events" USING btree ("target","ts");--> statement-breakpoint
CREATE INDEX "events_room_ts" ON "events" USING btree ("room_id","ts");--> statement-breakpoint
CREATE INDEX "events_type_ts" ON "events" USING btree ("type","ts");--> statement-breakpoint
CREATE INDEX "events_ts" ON "events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "events_reveal" ON "events" USING btree ("reveal_at");--> statement-breakpoint
CREATE INDEX "highlights_ts" ON "highlights" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "journal_agent_ts" ON "journal_entries" USING btree ("agent_id","ts");--> statement-breakpoint
CREATE INDEX "market_trades_item_ts" ON "market_trades" USING btree ("item","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "owners_provider_ext" ON "owners" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "push_owner" ON "push_subscriptions" USING btree ("owner_id");