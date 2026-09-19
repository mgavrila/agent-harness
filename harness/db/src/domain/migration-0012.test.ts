import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { LEGACY_0011_DDL } from './legacy-0011.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { rejectionMessage } from './postgres-error.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0012_memory_and_playbooks.sql');
const scratch = scratchDatabase(`harness_test_migration_0012_${process.pid}`);
const THREAD = '22222222-2222-4222-8222-222222222222';

let db: Db;
let close: () => Promise<void>;

/**
 * Unlike the 0011 test, the migration is applied once, up front, and not rolled back: the
 * assertion that matters here is what the migration does to rows that already exist, so the
 * rows go in first, the migration runs over them, and every test reads the result. The scratch
 * database is dropped afterwards.
 */
beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, LEGACY_0011_DDL));
  await db.execute(
    sql.raw(
      `INSERT INTO threads (id, client, surface, conversation, principal_id) VALUES ('${THREAD}', 'demo', 'memory', 'memory', 'u-1')`,
    ),
  );
  await db.execute(
    sql.raw(
      `INSERT INTO messages (thread_id, role, principal_id, content, created_at) VALUES
        ('${THREAD}', 'user', 'u-1', 'first', '2026-09-15T12:00:00Z'),
        ('${THREAD}', 'assistant', 'u-1', 'second', '2026-09-15T12:00:00Z')`,
    ),
  );
  for (const statement of migrationStatements(MIGRATION)) await db.execute(sql.raw(statement));
});
afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0012_memory_and_playbooks', () => {
  it('numbers the messages that already existed, in insertion order, and keeps numbering', async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO messages (thread_id, role, principal_id, content) VALUES ('${THREAD}', 'user', 'u-1', 'third')`,
      ),
    );
    const rows = (await db.execute(sql.raw(`SELECT content, seq FROM messages ORDER BY seq`))).rows;
    expect(rows.map((r) => r.content)).toEqual(['first', 'second', 'third']);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
  });

  it('creates memory_entries with the two scopes and a nullable thread tag', async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO memory_entries (client, scope, principal_id, text, created_by, thread_id) VALUES
          ('demo', 'principal', 'u-1', 'prefers bullets', 'u-1', '${THREAD}'),
          ('demo', 'client', NULL, 'the office closes at five', 'u-1', NULL)`,
      ),
    );
    const rows = (await db.execute(sql.raw(`SELECT scope, principal_id, thread_id FROM memory_entries ORDER BY scope`)))
      .rows;
    expect(rows).toEqual([
      { scope: 'client', principal_id: null, thread_id: null },
      { scope: 'principal', principal_id: 'u-1', thread_id: THREAD },
    ]);
  });

  it('creates playbooks keyed by (client, name) with the documented defaults, and playbook_runs pointing at them', async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO playbooks (client, name, schedule, skill, prompt, principal_id, cost_cap_usd) VALUES ('demo', 'nightly', '0 7 * * *', 'a-skill', 'run it', 'svc-playbooks', 0.5)`,
      ),
    );
    const [playbook] = (
      await db.execute(sql.raw(`SELECT timezone, deliver, timeout_s, enabled, next_run_at, last_status FROM playbooks`))
    ).rows;
    expect(playbook).toEqual({
      timezone: 'UTC',
      deliver: 'none',
      timeout_s: 600,
      enabled: true,
      next_run_at: null,
      last_status: null,
    });
    await db.execute(
      sql.raw(`INSERT INTO playbook_runs (playbook_id, scheduled_at) SELECT id, '2026-09-16T07:00:00Z' FROM playbooks`),
    );
    const [run] = (await db.execute(sql.raw(`SELECT status, attempts, run_id, requested_by FROM playbook_runs`))).rows;
    expect(run).toEqual({ status: 'requested', attempts: 0, run_id: null, requested_by: null });
    const duplicate = db.execute(
      sql.raw(
        `INSERT INTO playbooks (client, name, schedule, skill, prompt, principal_id, cost_cap_usd) VALUES ('demo', 'nightly', '0 8 * * *', 'a-skill', 'again', 'svc-playbooks', 1)`,
      ),
    );
    await expect(rejectionMessage(duplicate)).resolves.toMatch(/playbooks_client_name_uq/);
  });
});
