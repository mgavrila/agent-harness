import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { knowledgeChunks, knowledgeDocuments } from '@harness/db';
import { makeTestDeps, startFakeGateway, useTestDb, type FakeGateway } from '../../testing.js';
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
async function clientFolder(client = 'test'): Promise<{
  deps: ToolDeps;
  dir: string;
  fake: FakeGateway;
  write: (rel: string, text: string) => Promise<void>;
}> {
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
  return { deps, dir, fake, write };
}

/** The reason `syncKnowledge` gives for a document it refused, asserted rather than restated. */
const RESTRICTED = 'it contains a restricted identifier; remove it from the document and sync again';

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
    const { deps, fake, write } = await clientFolder();
    await write('a.md', '# A\n\none\n');
    expect((await syncKnowledge(deps)).added).toBe(1);
    expect(fake.embeddings).toHaveLength(1);

    const second = await syncKnowledge(deps);
    expect(second).toMatchObject({ scanned: 1, added: 0, updated: 0, unchanged: 1, chunks: 0 });
    // The gateway's own request log is the evidence, not `chunks: 0`: a sync that embedded the
    // document and then decided not to write its chunks would report `chunks: 0` too, and the
    // whole point of the hash is to not make the call.
    expect(fake.embeddings).toHaveLength(1);

    await write('a.md', '# A\n\none and two\n');
    const third = await syncKnowledge(deps);
    expect(third).toMatchObject({ scanned: 1, added: 0, updated: 1, unchanged: 0, chunks: 1 });
    expect(fake.embeddings).toHaveLength(2);
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
    expect(result.skipped).toEqual([{ path: 'leaky.md', reason: RESTRICTED }]);
    const rows = await db.select().from(knowledgeDocuments);
    expect(rows.map((r) => r.path)).toEqual(['fine.md']);
  });

  it('skips a document whose own path carries a restricted identifier', async () => {
    const { deps, write } = await clientFolder();
    // A path is returned to the model as part of a citation, so it reaches a run event exactly
    // as the text does and invariant 10 covers it too. The title is given explicitly here so
    // that the filename cannot be caught by the title check standing in for the path one.
    await write('cases/case-123-45-6789.md', '---\ntitle: A case\n---\n\nNothing restricted in the body.\n');

    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({ scanned: 1, added: 0, updated: 0, chunks: 0 });
    expect(result.skipped).toEqual([{ path: 'cases/case-123-45-6789.md', reason: RESTRICTED }]);
    expect(await db.$count(knowledgeDocuments)).toBe(0);
  });

  it('leaves a document exactly as it was when its embedding fails, and takes it on a later sync', async () => {
    const { deps, fake, write } = await clientFolder();
    await write('first.md', '# First\n\nfirst\n');
    await write('second.md', '# Second\n\nsecond\n');
    expect((await syncKnowledge(deps)).added).toBe(2);
    const before = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    const secondBefore = before.find((r) => r.path === 'second.md');

    // The gateway refuses whatever carries the marker, so which document fails is decided by
    // content rather than by call order, whatever order the folder is walked in.
    fake.setEmbeddingResponder((call) => (call.input.some((text) => text.includes('marker')) ? { status: 500 } : {}));
    await write('first.md', '# First\n\nfirst, revised\n');
    await write('second.md', '# Second\n\nsecond, with a marker\n');
    await write('third.md', '# Third\n\nbrand new, with a marker\n');

    const failed = await syncKnowledge(deps);
    // The one document that embedded is complete; neither of the others is counted as synced,
    // and neither is tombstoned — their files are on disk, they simply did not get through.
    expect(failed).toMatchObject({ scanned: 3, added: 0, updated: 1, unchanged: 0, removed: 0, chunks: 1 });
    expect(failed.skipped.map((s) => s.path)).toEqual(['second.md', 'third.md']);
    for (const skip of failed.skipped) expect(skip.reason).toContain('could not be embedded');

    // `second.md` keeps its previous row *and* its previous chunks: the new hash is not stored
    // without the chunks that go with it, or the next sync would call it unchanged forever.
    const secondAfter = (await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.path, 'second.md')))[0];
    expect(secondAfter.sha256).toBe(secondBefore?.sha256);
    expect(secondAfter.updatedAt).toEqual(secondBefore?.updatedAt);
    const secondChunks = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, secondAfter.id));
    expect(secondChunks.map((c) => c.text)).toEqual(['# Second\n\nsecond']);
    // `third.md` was new, so it has no row at all rather than a row with no chunks.
    expect(await db.$count(knowledgeDocuments, eq(knowledgeDocuments.path, 'third.md'))).toBe(0);

    fake.setEmbeddingResponder(() => ({}));
    const healed = await syncKnowledge(deps);
    expect(healed).toMatchObject({ scanned: 3, added: 1, updated: 1, unchanged: 1, chunks: 2, skipped: [] });
    const secondHealed = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, secondAfter.id));
    expect(secondHealed.map((c) => c.text)).toEqual(['# Second\n\nsecond, with a marker']);
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
