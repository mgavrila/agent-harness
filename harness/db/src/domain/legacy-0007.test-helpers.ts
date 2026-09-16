import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';

/**
 * The five tables migration 0008 touches, exactly as they stood after 0007.
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

/** The database the migration test builds and drops. Nothing else in the repository uses it. */
export const MIGRATION_DATABASE = 'harness_test_migration';

/** `maintenanceUrl` with its database swapped for `MIGRATION_DATABASE`, everything else intact. */
export function migrationDatabaseUrl(maintenanceUrl: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${MIGRATION_DATABASE}`;
  return url.toString();
}

/**
 * Build a database that looks like the world just after migration 0007, and hand back a handle
 * on it.
 *
 * `maintenanceUrl` is `TEST_DATABASE_URL`: `CREATE DATABASE` has to be issued from a connection
 * to some *other* database, and `harness_test` is the one that is always there. The drop-first
 * is for the run after a crashed one; `WITH (FORCE)` closes any connection a dead worker left
 * behind. Neither statement may run inside a transaction, which is why they go straight at the
 * pool rather than through `db.transaction`.
 *
 * The tables land in the new database's own `public` schema. That is the whole point: the
 * migration's generated SQL is schema-qualified to `"public"`, so it replays byte for byte,
 * with no rewriting and no `search_path` to get wrong.
 */
export async function createLegacyDatabase(maintenanceUrl: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const maintenance = createDb(maintenanceUrl);
  try {
    await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${MIGRATION_DATABASE}" WITH (FORCE)`));
    await maintenance.db.execute(sql.raw(`CREATE DATABASE "${MIGRATION_DATABASE}"`));
  } finally {
    await maintenance.close();
  }

  const scratch = createDb(migrationDatabaseUrl(maintenanceUrl));
  try {
    await scratch.db.execute(sql.raw(LEGACY_0007_DDL));
  } catch (err) {
    await scratch.close();
    throw err;
  }
  return { db: scratch.db, close: scratch.close };
}

/**
 * Drop the scratch database. Safe to call when it was never created, and safe to call twice.
 * The caller closes its own pool on the scratch database *first*, or the drop blocks behind it
 * — `WITH (FORCE)` covers the case where it forgot.
 */
export async function dropLegacyDatabase(maintenanceUrl: string): Promise<void> {
  const maintenance = createDb(maintenanceUrl);
  try {
    await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${MIGRATION_DATABASE}" WITH (FORCE)`));
  } finally {
    await maintenance.close();
  }
}
