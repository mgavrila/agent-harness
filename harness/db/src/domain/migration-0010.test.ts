import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { LEGACY_0009_DDL } from './legacy-0009.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0010_run_principal.sql');

const scratch = scratchDatabase(`harness_test_migration_0010_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, LEGACY_0009_DDL));
});

afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0010_run_principal', () => {
  it('has a hand-written data section, bracketed by the markers this test reads', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('-- harness:data-section:begin');
    expect(text).toContain('-- harness:data-section:end');
    expect(text.indexOf('UPDATE "runs"')).toBeGreaterThan(text.indexOf('-- harness:data-section:begin'));
    expect(text.indexOf('SET NOT NULL')).toBeGreaterThan(text.indexOf('-- harness:data-section:end'));
  });

  it('backfills principal_id from caller and adds the three nullable addressing columns', async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`
        INSERT INTO runs (id, client, caller) VALUES
          ('11111111-1111-4111-8111-111111111111', 'demo', 'hermes'),
          ('22222222-2222-4222-8222-222222222222', 'demo', 'approvals-app');
      `),
        );

        for (const statement of migrationStatements(MIGRATION)) await tx.execute(sql.raw(statement));

        const rows = (
          await tx.execute(
            sql.raw(`SELECT caller, principal_id, thread_id, surface, conversation FROM runs ORDER BY caller`),
          )
        ).rows;
        expect(rows).toEqual([
          {
            caller: 'approvals-app',
            principal_id: 'approvals-app',
            thread_id: null,
            surface: null,
            conversation: null,
          },
          { caller: 'hermes', principal_id: 'hermes', thread_id: null, surface: null, conversation: null },
        ]);

        const columns = (
          await tx.execute(
            sql.raw(
              `SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'runs' AND column_name IN ('principal_id', 'thread_id', 'surface', 'conversation') ORDER BY column_name`,
            ),
          )
        ).rows;
        expect(columns).toEqual([
          { column_name: 'conversation', is_nullable: 'YES', data_type: 'text' },
          { column_name: 'principal_id', is_nullable: 'NO', data_type: 'text' },
          { column_name: 'surface', is_nullable: 'YES', data_type: 'text' },
          { column_name: 'thread_id', is_nullable: 'YES', data_type: 'uuid' },
        ]);

        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
