/**
 * The two tables migration 0011 touches, as they stood after 0010.
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would agree
 * with a migration that dropped a column. No other table is here: 0011 adds `threads` and
 * `messages` from nothing, and only alters `runs` and `approvals`.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export const LEGACY_0010_DDL = `
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"caller" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" uuid,
	"surface" text,
	"conversation" text,
	"channel" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
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
	"surface" text,
	"conversation_id" text,
	"message_ref" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
`;
