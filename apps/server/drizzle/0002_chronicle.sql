CREATE TABLE "village_timeline" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"ts" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "highlights" ADD COLUMN "seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "highlights" ADD COLUMN "drama" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "highlights" ADD COLUMN "extra" jsonb;--> statement-breakpoint
ALTER TABLE "village_stats_daily" ADD COLUMN "online_peak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "village_stats_daily" ADD COLUMN "projects_today" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "village_stats_daily" ADD COLUMN "trades" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "village_stats_daily" ADD COLUMN "newcomers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "village_timeline_seq" ON "village_timeline" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "board_tag_ts" ON "board_posts" USING btree ("tag","ts");--> statement-breakpoint
CREATE INDEX "events_delayed_id" ON "events" USING btree ("id") WHERE "events"."visibility" = 'delayed';--> statement-breakpoint
CREATE INDEX "highlights_seq" ON "highlights" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "market_trades_ts" ON "market_trades" USING btree ("ts");