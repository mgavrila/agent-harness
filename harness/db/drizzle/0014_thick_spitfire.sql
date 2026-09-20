CREATE TABLE "client_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"version" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_documents" (
	"client_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"version" text NOT NULL,
	"blueprint_ref" text,
	"overlay" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "approvals_idempotency_pending_uq";--> statement-breakpoint
DROP INDEX "tool_effects_idempotency_uq";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "client" text NOT NULL;--> statement-breakpoint
ALTER TABLE "deadlines" ADD COLUMN "client" text NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "client" text NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client" text NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "client" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_usd" real DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "client_document_versions_client_version_uq" ON "client_document_versions" USING btree ("client_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_client_idempotency_pending_uq" ON "approvals" USING btree ("client","idempotency_key") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "tool_effects_client_idempotency_uq" ON "tool_effects" USING btree ("client","idempotency_key");--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "input_tokens";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "output_tokens";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "cost_usd";--> statement-breakpoint
CREATE VIEW "public"."usage_runs" AS (with "run_totals" as (
      select "client", "principal_id", date_trunc('day', "started_at") as "day",
        count(*)::int as "runs",
        coalesce(sum("input_tokens"), 0)::int as "input_tokens",
        coalesce(sum("output_tokens"), 0)::int as "output_tokens",
        coalesce(sum("cost_usd"), 0)::real as "cost_usd",
        coalesce(sum(extract(epoch from (coalesce("ended_at", "started_at") - "started_at"))), 0)::int as "duration_seconds",
        count(*) filter (where "status" = 'done')::int as "runs_done",
        count(*) filter (where "status" = 'error')::int as "runs_error",
        count(*) filter (where "status" = 'cancelled')::int as "runs_cancelled",
        count(*) filter (where "status" = 'running')::int as "runs_running"
      from "runs" group by 1, 2, 3
    ), "approval_totals" as (
      select "client", "requested_by" as "principal_id", date_trunc('day', "created_at") as "day",
        count(*)::int as "approvals_requested",
        count(*) filter (where "decided_at" is not null)::int as "approvals_decided"
      from "approvals" group by 1, 2, 3
    )
    select
      coalesce(r."client", a."client") as "client",
      coalesce(r."principal_id", a."principal_id") as "principal_id",
      coalesce(r."day", a."day") as "day",
      coalesce(r."runs", 0) as "runs",
      coalesce(r."input_tokens", 0) as "input_tokens",
      coalesce(r."output_tokens", 0) as "output_tokens",
      coalesce(r."cost_usd", 0) as "cost_usd",
      coalesce(r."duration_seconds", 0) as "duration_seconds",
      coalesce(r."runs_done", 0) as "runs_done",
      coalesce(r."runs_error", 0) as "runs_error",
      coalesce(r."runs_cancelled", 0) as "runs_cancelled",
      coalesce(r."runs_running", 0) as "runs_running",
      coalesce(a."approvals_requested", 0) as "approvals_requested",
      coalesce(a."approvals_decided", 0) as "approvals_decided",
      0 as "sandbox_seconds"
    from "run_totals" r
    full join "approval_totals" a
      on a."client" = r."client" and a."principal_id" = r."principal_id" and a."day" = r."day");