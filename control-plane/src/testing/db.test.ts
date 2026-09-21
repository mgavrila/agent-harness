import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { scratchDatabase, TEST_DATABASE_URL } from './db.js';

async function scratchDatabaseCount(): Promise<number> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const rows = await admin.query("SELECT 1 FROM pg_database WHERE datname LIKE 'hf1_scratch_%'");
  await admin.end();
  return rows.rowCount ?? 0;
}

describe('scratchDatabase', () => {
  it('drops the scratch database (and closes its pool) when setup fails partway through', async () => {
    // Compared as a delta, not an absolute count, since another suite's own scratch database may
    // legitimately be alive for the duration of its file.
    const before = await scratchDatabaseCount();
    await expect(scratchDatabase({ ddlFile: '/does/not/exist/kernel-ddl.sql' })).rejects.toThrow();
    const after = await scratchDatabaseCount();
    expect(after).toBe(before);
  });
});
