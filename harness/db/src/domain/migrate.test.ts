import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const scratch = scratchDatabase(`harness_test_migrate_all_${process.pid}`);
const scratchUrl = (): string => {
  const parsed = new URL(TEST_DATABASE_URL);
  parsed.pathname = `/harness_test_migrate_all_${process.pid}`;
  return parsed.toString();
};

afterAll(async () => {
  await scratch.drop(TEST_DATABASE_URL);
});

describe('runMigrations', () => {
  it('installs the vector extension and then applies every migration, on a database that had neither', async () => {
    // `create` makes the database and applies a trivial fixture; the point of this test is that
    // runMigrations needs no help beyond that — no pre-installed extension, no manual DDL.
    const { close } = await scratch.create(TEST_DATABASE_URL, 'SELECT 1');
    await close();

    await runMigrations(scratchUrl());

    const { db, close: closeScratch } = createDb(scratchUrl());
    try {
      const [extension] = (await db.execute(sql.raw(`SELECT extname FROM pg_extension WHERE extname = 'vector'`))).rows;
      expect(extension).toEqual({ extname: 'vector' });
      const [chunks] = (await db.execute(sql.raw(`SELECT to_regclass('public.knowledge_chunks')::text AS table_name`)))
        .rows;
      expect(chunks).toEqual({ table_name: 'knowledge_chunks' });
      // Idempotent: a second run is the ordinary case (every test-global-setup calls it).
      await runMigrations(scratchUrl());
    } finally {
      await closeScratch();
    }
  }, 60_000);
});
