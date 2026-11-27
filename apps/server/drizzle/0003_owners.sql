CREATE TABLE "blocked_words" (
	"word" text PRIMARY KEY NOT NULL,
	"added_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "claim_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_seen_at" bigint;--> statement-breakpoint
ALTER TABLE "board_posts" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Nothing wrote push subscriptions before this migration; clear any stray row so the NOT NULL column can be added.
DELETE FROM "push_subscriptions";--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "endpoint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "details" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "refreshed_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "reports_ts" ON "reports" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "sessions_owner" ON "sessions" USING btree ("owner_id");