import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { knowledgeChunks, knowledgeDocuments } from '@harness/db';
import { makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';
import { syncKnowledge } from './sync.js';

const db = useTestDb();

/**
 * A client folder with a `knowledge/` directory, and deps whose gateway is the fake. The client
 * name is a parameter so the last test can build a second client and prove one folder's sync
 * leaves the other's documents alone.
 *
 * The embedding width is the deps default, which is the width `knowledge_chunks.embedding` was
 * created at: pgvector checks a vector against the column's declared dimension on insert, so a
 * narrower one here would be rejected by Postgres rather than exercising anything.
 */
async function clientFolder(
  client = 'test',
): Promise<{ deps: ToolDeps; dir: string; write: (rel: string, text: string) => Promise<void> }> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  const dir = path.join(clientDir, 'knowledge');
  await mkdir(dir, { recursive: true });
  const deps = makeTestDeps(db, {
    client,
    clientDir,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
  });
  const write = async (rel: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  return { deps, dir, write };
}

describe('syncKnowledge', () => {
  it('adds every document, chunks and embeds it, and reports what it did', async () => {
    const { deps, write } = await clientFolder();
    await write('front-desk.md', '---\ntitle: Front desk\n---\n\nThe office closes at five.\n');
    await write(
      'policies/escalation.md',
      '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate anything urgent.\n',
    );

    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({
      source: 'client-folder',
      scanned: 2,
      added: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      chunks: 2,
      skipped: [],
    });
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.minLevel, r.minRank])).toEqual([
      ['front-desk.md', 'member', 0],
      ['policies/escalation.md', 'lead', 2],
    ]);
    const chunks = await db.select().from(knowledgeChunks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].embedding).toHaveLength(deps.embedDims);
  });

  it('does not re-embed an unchanged document, and does re-embed a changed one', async () => {
    const { deps, write } = await clientFolder();
    await write('a.md', '# A\n\none\n');
    expect((await syncKnowledge(deps)).added).toBe(1);

    const second = await syncKnowledge(deps);
    expect(second).toMatchObject({ scanned: 1, added: 0, updated: 0, unchanged: 1, chunks: 0 });

    await write('a.md', '# A\n\none and two\n');
    const third = await syncKnowledge(deps);
    expect(third).toMatchObject({ scanned: 1, added: 0, updated: 1, unchanged: 0, chunks: 1 });
    const [row] = await db.select().from(knowledgeChunks);
    expect(row.text).toContain('one and two');
  });

  it('tombstones a document whose file is gone and drops its chunks', async () => {
    const { deps, dir, write } = await clientFolder();
    await write('keep.md', '# Keep\n\nhere\n');
    await write('drop.md', '# Drop\n\ngone soon\n');
    expect((await syncKnowledge(deps)).added).toBe(2);

    await rm(path.join(dir, 'drop.md'));
    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({ scanned: 1, added: 0, unchanged: 1, removed: 1, chunks: 0 });
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.deletedAt === null])).toEqual([
      ['drop.md', false],
      ['keep.md', true],
    ]);
    expect(await db.$count(knowledgeChunks)).toBe(1);
  });

  it('skips a document carrying a restricted identifier, naming it, and syncs the rest', async () => {
    const { deps, write } = await clientFolder();
    await write('fine.md', '# Fine\n\nnothing restricted here\n');
    // A social security number in a knowledge document would reach knowledge_chunks, which
    // invariant 10 forbids, and from there the model.
    await write('leaky.md', '# Leaky\n\nThe file number is 123-45-6789 for reference.\n');

    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({ scanned: 2, added: 1, chunks: 1 });
    expect(result.skipped).toEqual([
      { path: 'leaky.md', reason: 'it contains a restricted identifier; remove it from the document and sync again' },
    ]);
    const rows = await db.select().from(knowledgeDocuments);
    expect(rows.map((r) => r.path)).toEqual(['fine.md']);
  });

  it('is an empty sync, not an error, for a client with no knowledge folder', async () => {
    const deps = makeTestDeps(db, { clientDir: path.join(tmpdir(), 'harness-client-nonexistent') });
    expect(await syncKnowledge(deps)).toMatchObject({ scanned: 0, added: 0, removed: 0, chunks: 0, skipped: [] });
  });

  it('leaves another client’s documents alone when it tombstones', async () => {
    const mine = await clientFolder();
    await mine.write('shared-name.md', '# Mine\n\nmine\n');
    await syncKnowledge(mine.deps);

    const theirs = await clientFolder('other-client');
    await theirs.write('different.md', '# Theirs\n\ntheirs\n');
    expect(await syncKnowledge(theirs.deps)).toMatchObject({ scanned: 1, added: 1, removed: 0 });

    // Sources are keyed by client, so the other client's folder holding none of my paths
    // tombstones none of my documents.
    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.client, 'test'));
    expect(rows.map((r) => [r.path, r.deletedAt])).toEqual([['shared-name.md', null]]);
  });
});
