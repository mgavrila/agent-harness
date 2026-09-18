import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../drizzle');

/**
 * Extensions the schema needs, installed before the migrator runs.
 *
 * `drizzle-kit generate` writes `CREATE TABLE`s and `CREATE INDEX`es and never a
 * `CREATE EXTENSION`, and this repository does not hand-edit a generated migration or use
 * `--custom` (see "Writing migrations" in docs/runbook.md). So the one statement the generator
 * cannot write is issued here, on every run, idempotently: migration 0013 declares
 * `embedding vector(1024)` and fails with `type "vector" does not exist` without it.
 *
 * It needs a database role that may create an extension. The application role must not be that
 * role — migrations are run by the owner, which is what "Database roles" in the runbook already
 * says — and `IF NOT EXISTS` makes the second and every later run a no-op rather than an error.
 */
const EXTENSIONS = ['vector'] as const;

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    for (const extension of EXTENSIONS) {
      await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${extension}`));
    }
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
