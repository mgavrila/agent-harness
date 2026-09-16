ALTER TABLE "approvals" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "approvals" SET "claimed_at" = "created_at" WHERE "slack_channel" IS NOT NULL AND "slack_ts" IS NULL AND "claimed_at" IS NULL;
