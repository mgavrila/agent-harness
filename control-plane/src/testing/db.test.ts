import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { scratchDatabase, TEST_DATABASE_URL } from './db.js';

async function scratchDatabaseNames(): Promise<Set<string>> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const rows = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'hf1_scratch_%'");
  await admin.end();
  return new Set(rows.rows.map((row: { datname: string }) => row.datname));
}

describe('scratchDatabase', () => {
  it('drops the scratch database (and closes its pool) when setup fails partway through', async () => {
    // Compared by name, not by count: vitest runs this package's test files in parallel, and
    // another file's own scratch database may be created or dropped concurrently. Only a name
    // that appears AFTER but was not there BEFORE is a candidate leak from this test — and even
    // that can be a sibling file's own scratch database, created just after BEFORE was taken but
    // not yet dropped by its own file's afterAll. So a candidate only counts as a leak once it
    // survives a short settle window; a name that disappears on its own was never ours.
    const before = await scratchDatabaseNames();
    await expect(scratchDatabase({ ddlFile: '/does/not/exist/kernel-ddl.sql' })).rejects.toThrow();
    let leaked = [...(await scratchDatabaseNames())].filter((name) => !before.has(name));
    for (let attempt = 0; leaked.length > 0 && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      leaked = [...(await scratchDatabaseNames())].filter((name) => !before.has(name));
    }
    expect(leaked).toEqual([]);
  });
});
