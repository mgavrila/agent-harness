ALTER TABLE "approvals" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "message_ref" text;--> statement-breakpoint
-- harness:data-section:begin
-- Hand written. Moves today's Slack addressing onto the neutral columns and renames the two
-- sink names that are still in flight.
--
-- `surface = 'slack'` is set only where a card was actually posted: `slack_channel IS NOT NULL`
-- is what "this row reached a surface" has meant since 0000, and it is the same predicate 0007
-- used to backfill `claimed_at`. A row that was never posted keeps three nulls, which is exactly
-- what the poller looks for.
--
-- A row that was claimed but never got a `slack_ts` keeps its `claimed_at` and lands with
-- `conversation_id` set and `message_ref` null — the stale-claim state, so the sweep on the next
-- tick recovers it just as it would have before the upgrade.
UPDATE "approvals"
SET "surface" = 'slack', "conversation_id" = "slack_channel", "message_ref" = "slack_ts"
WHERE "slack_channel" IS NOT NULL;--> statement-breakpoint
-- The outbox holds rows staged by the kernel that was running a minute ago, and the dispatcher
-- looks a sink up by the exact string on the row. Renaming only the rows that can still be sent
-- is deliberate: a `dispatched` or `failed` row is history, and rewriting its sink name would
-- change the record of what actually happened.
--
-- Their payloads are NOT rewritten, because they cannot be: `payload_encrypted` is ciphertext
-- and SQL has no key. The host's surface sinks resolve a payload with no `surface` to the
-- primary surface and read the pre-0009 `channel` key as the conversation, so an in-flight row
-- delivers exactly where it would have. See the plan's decision 6.
UPDATE "tool_effects" SET "sink" = 'surface_message'
WHERE "sink" = 'slack_message' AND "status" IN ('staged', 'dispatching', 'needs_review');--> statement-breakpoint
UPDATE "tool_effects" SET "sink" = 'surface_file'
WHERE "sink" = 'slack_file' AND "status" IN ('staged', 'dispatching', 'needs_review');--> statement-breakpoint
-- harness:data-section:end
ALTER TABLE "approvals" DROP COLUMN "slack_channel";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "slack_ts";
