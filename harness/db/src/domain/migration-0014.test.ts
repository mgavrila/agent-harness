import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';
import { runMigrations } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '../../drizzle');
const scratch = scratchDatabase(`harness_test_migration_0014_${process.pid}`);

/**
 * The migration by its prefix rather than its full name: `drizzle-kit generate` picks the
 * adjective and the noun, the journal records whatever it chose, and renaming a generated file
 * is the one thing this repository never does to one.
 */
async function migrationFile(prefix: string): Promise<string> {
  const names = (await readdir(drizzleDir)).filter((name) => name.startsWith(prefix) && name.endsWith('.sql'));
  expect(names, `exactly one ${prefix} migration`).toHaveLength(1);
  return path.join(drizzleDir, names[0]);
}

afterAll(async () => {
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0014', () => {
  it('adds the tenant column to the five tables that lacked one, and nowhere else', async () => {
    const statements = migrationStatements(await migrationFile('0014'));
    const added = statements
      .filter((s) => /ADD COLUMN "client"/.test(s))
      .map((s) => /ALTER TABLE "([a-z_]+)"/.exec(s)?.[1])
      .sort();
    expect(added).toEqual(['attachments', 'deadlines', 'fields', 'messages', 'playbook_runs']);
    // NOT NULL with no default, deliberately: a default would file every existing row under one
    // tenant, which is the opposite of what this migration is for.
    expect(statements.some((s) => /ADD COLUMN "client" text NOT NULL;?$/.test(s.trim()))).toBe(true);
  });

  it('makes both idempotency keys unique per client rather than globally', async () => {
    const statements = migrationStatements(await migrationFile('0014'));
    expect(statements.some((s) => s.includes('DROP INDEX "approvals_idempotency_pending_uq"'))).toBe(true);
    expect(statements.some((s) => s.includes('DROP INDEX "tool_effects_idempotency_uq"'))).toBe(true);
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX "approvals_client_idempotency_pending_uq".*"client","idempotency_key"/s.test(s),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX "tool_effects_client_idempotency_uq".*"client","idempotency_key"/s.test(s),
      ),
    ).toBe(true);
  });

  it('drops the three audit columns nothing ever wrote', async () => {
    const statements = migrationStatements(await migrationFile('0014'));
    for (const column of ['input_tokens', 'output_tokens', 'cost_usd']) {
      expect(statements.some((s) => s.includes(`ALTER TABLE "audit_log" DROP COLUMN "${column}"`))).toBe(true);
    }
  });

  it('applies whole to a database that has never seen it, view and all', async () => {
    const { db, close } = await scratch.create(TEST_DATABASE_URL, 'SELECT 1');
    try {
      await runMigrations(scratch.url(TEST_DATABASE_URL));
      const views = await db.execute(
        sql.raw(`select table_name from information_schema.views where table_schema = 'public'`),
      );
      expect(views.rows.map((r) => r.table_name)).toContain('usage_runs');
      // The export answers on an empty database rather than erroring, which is what a tenant
      // with no runs yet asks it to do.
      expect((await db.execute(sql.raw('select * from usage_runs'))).rows).toEqual([]);
      const columns = await db.execute(
        sql.raw(
          `select column_name from information_schema.columns where table_name = 'messages' and column_name = 'client'`,
        ),
      );
      expect(columns.rows).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
