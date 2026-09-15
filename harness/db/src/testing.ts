import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';

/**
 * Wipe every table between tests.
 *
 * `audit_log` carries a BEFORE TRUNCATE trigger that makes it append-only, so
 * the truncate is bracketed by an explicit disable/enable. This is a test-only
 * escape hatch: it works because the test role owns the tables. In production
 * the application role must not own them, so it cannot do this — see the
 * "Database roles" section of docs/runbook.md.
 */
export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  try {
    await db.execute(sql`
      TRUNCATE TABLE audit_log, model_calls, runs, approvals, deadlines,
        credentials, fields, documents, providers CASCADE
    `);
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  }
}
