import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { rejectionMessage } from './postgres-error.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0013_knowledge.sql');
const scratch = scratchDatabase(`harness_test_migration_0013_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

/**
 * No legacy fixture: 0013 creates three tables that reference nothing outside themselves, so the
 * database it replays into starts empty. What it does need is the extension, and the first test
 * below is about exactly that — so the extension is installed inside the tests, not here.
 */
beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, 'SELECT 1'));
});
afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

const apply = async (): Promise<void> => {
  for (const statement of migrationStatements(MIGRATION)) await db.execute(sql.raw(statement));
};

describe('migration 0013_knowledge', () => {
  it('refuses to apply without the vector extension, which is why runMigrations installs it', async () => {
    // The whole reason the CREATE EXTENSION lives in runMigrations rather than in this file: a
    // deployment that ran the migrator alone against a plain Postgres gets this, not a table.
    // Through `rejectionMessage`, as elsewhere in this package: drizzle's own message is only
    // "Failed query: …" and the Postgres error text is on the `.cause` it carries.
    await expect(rejectionMessage(apply())).resolves.toMatch(/type "vector" does not exist/);
  });

  it('creates the three tables, the HNSW and GIN indexes, and a 1024-wide embedding column', async () => {
    await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'));
    await apply();

    const tables = (
      await db.execute(
        sql.raw(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'knowledge%' ORDER BY table_name`,
        ),
      )
    ).rows;
    expect(tables).toEqual([
      { table_name: 'knowledge_chunks' },
      { table_name: 'knowledge_documents' },
      { table_name: 'knowledge_sources' },
    ]);

    // The declared width, read the way assertEmbedDims reads it at startup.
    const [column] = (
      await db.execute(
        sql.raw(
          `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'knowledge_chunks'::regclass AND attname = 'embedding'`,
        ),
      )
    ).rows;
    expect(column).toEqual({ atttypmod: 1024 });

    const indexes = (
      await db.execute(
        sql.raw(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'knowledge_chunks' ORDER BY indexname`),
      )
    ).rows as { indexname: string; indexdef: string }[];
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    // `pg_indexes.indexdef` is Postgres re-rendering the index it actually built, not the text
    // of the migration: it drops the quotes the generator wrote around every identifier. So the
    // migration file says `USING hnsw ("embedding" vector_cosine_ops)` and this says the same
    // thing unquoted — as the two gin assertions below already do.
    expect(byName.get('knowledge_chunks_embedding_idx')).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(byName.get('knowledge_chunks_tsv_idx')).toContain('USING gin (tsv)');
    expect(byName.get('knowledge_chunks_principals_idx')).toContain('USING gin (principals)');
  });

  it('cascades a document delete to its chunks, filters by rank and by a named principal, and ranks both ways', async () => {
    const seed = `
      INSERT INTO knowledge_sources (id, client, name, kind, location)
      VALUES ('11111111-1111-4111-8111-111111111111', 'demo', 'client-folder', 'folder', 'clients/demo/knowledge');
      INSERT INTO knowledge_documents (id, client, source_id, path, title, sha256, min_level, min_rank, principals)
      VALUES ('22222222-2222-4222-8222-222222222222', 'demo', '11111111-1111-4111-8111-111111111111',
              'front-desk.md', 'Front desk', '${'a'.repeat(64)}', 'member', 0, '{}'),
             ('33333333-3333-4333-8333-333333333333', 'demo', '11111111-1111-4111-8111-111111111111',
              'escalation.md', 'Escalation', '${'b'.repeat(64)}', 'lead', 2, '{u-analyst}');
      INSERT INTO knowledge_chunks (document_id, client, ordinal, text, embedding, min_level, min_rank, principals)
      VALUES ('22222222-2222-4222-8222-222222222222', 'demo', 0, 'the office closes at five',
              (SELECT ('[' || string_agg('0.01', ',') || ']')::vector FROM generate_series(1, 1024)), 'member', 0, '{}'),
             ('33333333-3333-4333-8333-333333333333', 'demo', 0, 'escalate anything urgent to the duty lead',
              (SELECT ('[' || string_agg('0.02', ',') || ']')::vector FROM generate_series(1, 1024)), 'lead', 2, '{u-analyst}');
    `;
    await db.execute(sql.raw(seed));

    // A member sees one chunk; a lead sees both; an analyst named on the second sees both too.
    const visible = async (rank: number, principal: string): Promise<number> => {
      const [row] = (
        await db.execute(
          sql.raw(
            `SELECT count(*)::int AS n FROM knowledge_chunks c
             JOIN knowledge_documents d ON d.id = c.document_id
             WHERE c.client = 'demo' AND d.deleted_at IS NULL
               AND (c.min_rank <= ${rank} OR c.principals @> ARRAY['${principal}'])`,
          ),
        )
      ).rows as { n: number }[];
      return row.n;
    };
    expect(await visible(0, 'u-nobody')).toBe(1);
    expect(await visible(2, 'u-nobody')).toBe(2);
    expect(await visible(0, 'u-analyst')).toBe(2);
    // A service principal's rank is -1, so nothing clears on level alone.
    expect(await visible(-1, 'u-nobody')).toBe(0);
    expect(await visible(-1, 'u-analyst')).toBe(1);

    // Both rankings answer over the same rows.
    const [lexical] = (
      await db.execute(
        sql.raw(`SELECT ordinal FROM knowledge_chunks WHERE tsv @@ plainto_tsquery('english', 'office closes')`),
      )
    ).rows;
    expect(lexical).toEqual({ ordinal: 0 });
    const nearest = (
      await db.execute(
        sql.raw(
          `SELECT text FROM knowledge_chunks
           ORDER BY embedding <=> (SELECT ('[' || string_agg('0.02', ',') || ']')::vector FROM generate_series(1, 1024))
           LIMIT 1`,
        ),
      )
    ).rows as { text: string }[];
    expect(nearest[0].text).toContain('escalate');

    // And the cascade the re-sync depends on.
    await db.execute(sql.raw(`DELETE FROM knowledge_documents WHERE path = 'escalation.md'`));
    const [left] = (await db.execute(sql.raw('SELECT count(*)::int AS n FROM knowledge_chunks'))).rows as {
      n: number;
    }[];
    expect(left.n).toBe(1);
  });
});
