import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:5433/harness_test';

export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE audit_log, model_calls, runs, approvals, deadlines,
      credentials, fields, documents, providers CASCADE
  `);
}
