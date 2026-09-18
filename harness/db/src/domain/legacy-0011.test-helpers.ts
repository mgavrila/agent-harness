/**
 * The three tables migration 0012 touches or references, as they stood after 0011.
 *
 * Copied out of the 0011 migration rather than derived from the current schema, on purpose: this
 * is the *old* shape, and a fixture generated from today's `schema.ts` would already carry `seq`.
 * `runs` is here only because `playbook_runs.run_id` references it; `approvals`, `tool_effects`
 * and the rest are untouched by 0012 and are not needed to replay it.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export const LEGACY_0011_DDL = `
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"surface" text NOT NULL,
	"conversation" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "threads_client_surface_conversation_principal_uq" ON "threads" USING btree ("client","surface","conversation","principal_id");
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" uuid REFERENCES "threads"("id"),
	"surface" text,
	"conversation" text,
	"channel" text,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL REFERENCES "threads"("id"),
	"run_id" uuid REFERENCES "runs"("id"),
	"role" text NOT NULL,
	"principal_id" text NOT NULL,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "messages_tsv_idx" ON "messages" USING gin ("tsv");
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");
`;
