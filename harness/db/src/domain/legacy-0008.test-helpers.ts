/**
 * The two tables migration 0009 touches, as they stood after 0008.
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would
 * happily agree with a migration that dropped half the data. The indexes are all three the 0008
 * snapshot records for these two tables, the non-unique one included: the sink rename selects on
 * `status`, so leaving it out would replay the migration against a plan the real database never
 * uses. `tool_effects.run_id` is declared without its foreign key because the `runs` table is not
 * here — 0009 does not touch it, and a fixture that recreated every table would be a second copy
 * of the schema to keep in step.
 */
export const LEGACY_0008_DDL = `
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_encrypted" bytea,
	"summary" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"slack_channel" text,
	"slack_ts" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "approvals_idempotency_pending_uq" ON "approvals" USING btree ("idempotency_key") WHERE status = 'pending';
CREATE TABLE "tool_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client" text NOT NULL,
	"tool" text NOT NULL,
	"sink" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_encrypted" bytea NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
CREATE UNIQUE INDEX "tool_effects_idempotency_uq" ON "tool_effects" USING btree ("idempotency_key");
CREATE INDEX "tool_effects_status_created_idx" ON "tool_effects" USING btree ("status","created_at");
`;
