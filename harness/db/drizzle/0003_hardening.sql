ALTER TABLE "approvals" ADD COLUMN "executed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "tool_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client" text NOT NULL,
	"tool" text NOT NULL,
	"sink" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_encrypted" "bytea" NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_effects" ADD CONSTRAINT "tool_effects_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_effects_idempotency_uq" ON "tool_effects" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "tool_effects_status_created_idx" ON "tool_effects" USING btree ("status","created_at");
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "skill" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "skill_version" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "input_tokens" integer;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "output_tokens" integer;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "cost_usd" real;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "derived_from" jsonb DEFAULT '[]'::jsonb NOT NULL;
