import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { LEGACY_0010_DDL } from './legacy-0010.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0011_threads_and_messages.sql');
const scratch = scratchDatabase(`harness_test_migration_0011_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, LEGACY_0010_DDL));
});
afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0011_threads_and_messages', () => {
  it('keeps every existing run and approval, drops caller, and adds status and thread_id with defaults', async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            `INSERT INTO runs (id, client, caller, principal_id) VALUES ('11111111-1111-4111-8111-111111111111', 'demo', 'u-1', 'u-1')`,
          ),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO approvals (client, action, payload, summary, requested_by, expires_at, idempotency_key) VALUES ('demo', 'forms_release', '{}', 's', 'u-1', now() + interval '1 day', 'k1')`,
          ),
        );
        for (const statement of migrationStatements(MIGRATION)) await tx.execute(sql.raw(statement));

        const runs = (await tx.execute(sql.raw(`SELECT principal_id, status, thread_id FROM runs`))).rows;
        expect(runs).toEqual([{ principal_id: 'u-1', status: 'running', thread_id: null }]);
        const columns = (
          await tx.execute(sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'runs'`))
        ).rows.map((r) => r.column_name);
        expect(columns).not.toContain('caller');
        const approvals = (await tx.execute(sql.raw(`SELECT thread_id FROM approvals`))).rows;
        expect(approvals).toEqual([{ thread_id: null }]);

        await tx.execute(
          sql.raw(
            `INSERT INTO threads (client, surface, conversation, principal_id) VALUES ('demo', 'memory', 'memory', 'u-1')`,
          ),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO messages (thread_id, role, principal_id, content) SELECT id, 'user', 'u-1', 'the licence expires soon' FROM threads`,
          ),
        );
        const hits = (
          await tx.execute(sql.raw(`SELECT content FROM messages WHERE tsv @@ plainto_tsquery('english', 'expires')`))
        ).rows;
        expect(hits).toEqual([{ content: 'the licence expires soon' }]);
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
