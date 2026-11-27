-- Sessions get an absolute cap from login (90 days), so their login time moves to the same unit as expires_at and
-- refreshed_at (epoch milliseconds). The old column was filled by now() at login, so every existing row keeps its
-- real login time. The default goes first: now() cannot be cast to bigint.
ALTER TABLE "sessions" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DATA TYPE bigint USING (floor(extract(epoch from "created_at") * 1000))::bigint;
