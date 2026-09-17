/**
 * The five tables migration 0008 touches, as they stood after 0007 (column order differs from the migrations, which appended text_path and client later; every statement names its columns).
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would
 * happily agree with a migration that dropped half the data. The indexes are the two the
 * migration drops by name plus the unique NPI index the copy has to satisfy; the audit,
 * approvals and effects tables are absent because 0008 does not touch them.
 */
export const LEGACY_0007_DDL = `
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"name" text NOT NULL,
	"npi" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "providers_client_name_idx" ON "providers" USING btree ("client","name");
CREATE UNIQUE INDEX "providers_client_npi_uq" ON "providers" USING btree ("client","npi");
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"provider_id" uuid REFERENCES "providers"("id"),
	"kind" text,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"pages" integer,
	"ocr_used" boolean DEFAULT false NOT NULL,
	"text_path" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "documents_client_ingested_idx" ON "documents" USING btree ("client","ingested_at");
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL REFERENCES "providers"("id"),
	"name" text NOT NULL,
	"value" text,
	"value_encrypted" "bytea",
	"restricted" boolean DEFAULT false NOT NULL,
	"confidence" real,
	"source_doc_id" uuid REFERENCES "documents"("id"),
	"source_page" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone
);
CREATE UNIQUE INDEX "fields_provider_name_uq" ON "fields" USING btree ("provider_id","name");
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL REFERENCES "providers"("id"),
	"kind" text NOT NULL,
	"issuer" text,
	"number_encrypted" "bytea",
	"state" text,
	"issued_at" date,
	"expires_at" date,
	"source_doc_id" uuid REFERENCES "documents"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "credentials_provider_idx" ON "credentials" USING btree ("provider_id");
CREATE TABLE "deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL REFERENCES "providers"("id"),
	"credential_id" uuid NOT NULL REFERENCES "credentials"("id"),
	"kind" text NOT NULL,
	"due_at" date NOT NULL,
	"window_days" integer DEFAULT 90 NOT NULL,
	"notified_at" timestamp with time zone
);
CREATE UNIQUE INDEX "deadlines_credential_kind_uq" ON "deadlines" USING btree ("credential_id","kind");
`;
