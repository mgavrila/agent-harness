CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"pack" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"issuer" text,
	"number_encrypted" "bytea",
	"state" text,
	"issued_at" date,
	"expires_at" date,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_doc_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "records_client_kind_name_idx" ON "records" USING btree ("client","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "records_client_kind_external_id_uq" ON "records" USING btree ("client","kind","external_id");--> statement-breakpoint
CREATE INDEX "attachments_record_idx" ON "attachments" USING btree ("record_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_source_doc_id_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "record_id" uuid;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "record_id" uuid;--> statement-breakpoint
ALTER TABLE "deadlines" ADD COLUMN "record_id" uuid;--> statement-breakpoint
ALTER TABLE "deadlines" ADD COLUMN "attachment_id" uuid;--> statement-breakpoint
-- harness:data-section:begin
-- Hand written. Copies the healthcare rows into the pack-typed model and re-points the three
-- tables that referenced them. Primary keys are preserved on purpose: deadlines_upcoming's
-- digest_key is a sha256 over credential ids, so a new id here would make every playbook speak
-- again on the first run after this migration. The columns are listed explicitly rather than
-- relying on SELECT *, so a future column added to either side cannot silently shift the copy.
INSERT INTO "records" ("id", "client", "pack", "kind", "name", "external_id", "status", "created_at", "updated_at")
SELECT "id", "client", 'healthcare', 'provider', "name", "npi", "status", "created_at", "updated_at"
FROM "providers";--> statement-breakpoint
INSERT INTO "attachments" ("id", "record_id", "kind", "issuer", "number_encrypted", "state", "issued_at", "expires_at", "properties", "source_doc_id", "created_at")
SELECT "id", "provider_id", "kind", "issuer", "number_encrypted", "state", "issued_at", "expires_at", '{}'::jsonb, "source_doc_id", "created_at"
FROM "credentials";--> statement-breakpoint
UPDATE "fields" SET "record_id" = "provider_id";--> statement-breakpoint
UPDATE "documents" SET "record_id" = "provider_id";--> statement-breakpoint
UPDATE "deadlines" SET "record_id" = "provider_id", "attachment_id" = "credential_id";--> statement-breakpoint
-- harness:data-section:end
ALTER TABLE "fields" ALTER COLUMN "record_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deadlines" ALTER COLUMN "record_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deadlines" ALTER COLUMN "attachment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX "fields_provider_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "fields_record_name_uq" ON "fields" USING btree ("record_id","name");--> statement-breakpoint
DROP INDEX "deadlines_credential_kind_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "deadlines_attachment_kind_uq" ON "deadlines" USING btree ("attachment_id","kind");--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "provider_id";--> statement-breakpoint
ALTER TABLE "fields" DROP COLUMN "provider_id";--> statement-breakpoint
ALTER TABLE "deadlines" DROP COLUMN "provider_id";--> statement-breakpoint
ALTER TABLE "deadlines" DROP COLUMN "credential_id";--> statement-breakpoint
DROP TABLE "credentials" CASCADE;--> statement-breakpoint
DROP TABLE "providers" CASCADE;
