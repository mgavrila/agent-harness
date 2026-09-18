import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { parseKnowledgeDocument } from './document.js';
import { findOrCreateSource, replaceChunks, tombstoneMissing, touchSource, upsertDocument } from './repository.js';

const db = useTestDb();
const NOW = new Date('2026-09-15T12:00:00Z');
const LATER = new Date('2026-09-16T12:00:00Z');

const vectorsFor = (chunks: readonly string[]): number[][] =>
  chunks.map((_, i) => Array.from({ length: 1024 }, () => (i + 1) / 100));

const doc = (path: string, text: string) => parseKnowledgeDocument(path, text);

const source = () =>
  findOrCreateSource(db, 'test', { name: 'client-folder', kind: 'folder', location: 'clients/test/knowledge' }, NOW);

describe('findOrCreateSource', () => {
  it('creates one row per client and name, and returns the same one afterwards', async () => {
    const first = await source();
    const again = await source();
    expect(again.id).toBe(first.id);
  });
});

describe('upsertDocument', () => {
  it('adds, then reports unchanged, then updates when the file changed', async () => {
    const { id: sourceId } = await source();
    const original = doc('front-desk.md', '---\ntitle: Front desk\n---\n\nCloses at five.\n');
    const added = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: NOW });
    expect(added.change).toBe('added');

    const same = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: LATER });
    expect(same).toEqual({ id: added.id, change: 'unchanged' });
    // `updated_at` is when the content last changed, which is what a citation shows, so an
    // unchanged document does not get a new one.
    const [untouched] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, added.id));
    expect(untouched.updatedAt).toEqual(NOW);

    const raised = doc('front-desk.md', '---\ntitle: Front desk\nmin_level: lead\n---\n\nCloses at five.\n');
    const changed = await upsertDocument(db, { client: 'test', sourceId, doc: raised, now: LATER });
    expect(changed).toEqual({ id: added.id, change: 'updated' });
    const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, added.id));
    expect(row).toMatchObject({ minLevel: 'lead', minRank: 2, updatedAt: LATER, deletedAt: null });
  });

  it('brings a tombstoned document back as an update when its file reappears', async () => {
    const { id: sourceId } = await source();
    const original = doc('holidays.md', '# Public holidays\n\nClosed.\n');
    const { id } = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: NOW });
    await tombstoneMissing(db, sourceId, [], NOW);
    const back = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: LATER });
    expect(back).toEqual({ id, change: 'updated' });
    const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    expect(row.deletedAt).toBeNull();
  });
});

describe('replaceChunks', () => {
  it('writes the chunks in order with the document access copied onto each, and replaces them wholesale', async () => {
    const { id: sourceId } = await source();
    const parsed = doc('billing.md', '---\ntitle: Billing\nmin_level: lead\nprincipals: [u-analyst]\n---\n\nRates.\n');
    const { id } = await upsertDocument(db, { client: 'test', sourceId, doc: parsed, now: NOW });

    const first = ['alpha', 'beta', 'gamma'];
    expect(
      await replaceChunks(db, {
        documentId: id,
        client: 'test',
        doc: parsed,
        chunks: first,
        vectors: vectorsFor(first),
      }),
    ).toBe(3);
    const rows = await db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, id))
      .orderBy(knowledgeChunks.ordinal);
    expect(rows.map((r) => [r.ordinal, r.text])).toEqual([
      [0, 'alpha'],
      [1, 'beta'],
      [2, 'gamma'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ client: 'test', minLevel: 'lead', minRank: 2, principals: ['u-analyst'] });
      expect(row.embedding).toHaveLength(1024);
    }

    const second = ['delta'];
    expect(
      await replaceChunks(db, {
        documentId: id,
        client: 'test',
        doc: parsed,
        chunks: second,
        vectors: vectorsFor(second),
      }),
    ).toBe(1);
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, id))).toBe(1);
  });
});

describe('tombstoneMissing', () => {
  it('tombstones the documents no longer in the folder, drops their chunks, and leaves the rest alone', async () => {
    const { id: sourceId } = await source();
    const kept = doc('kept.md', '# Kept\n\nstill here\n');
    const gone = doc('gone.md', '# Gone\n\nnot any more\n');
    const keptRow = await upsertDocument(db, { client: 'test', sourceId, doc: kept, now: NOW });
    const goneRow = await upsertDocument(db, { client: 'test', sourceId, doc: gone, now: NOW });
    for (const [id, parsed] of [
      [keptRow.id, kept],
      [goneRow.id, gone],
    ] as const) {
      await replaceChunks(db, {
        documentId: id,
        client: 'test',
        doc: parsed,
        chunks: ['one'],
        vectors: vectorsFor(['one']),
      });
    }

    expect(await tombstoneMissing(db, sourceId, ['kept.md'], LATER)).toBe(1);
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.deletedAt])).toEqual([
      ['gone.md', LATER],
      ['kept.md', null],
    ]);
    // The row stays for an operator to see; nothing can retrieve it, because its chunks are gone.
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, goneRow.id))).toBe(0);
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, keptRow.id))).toBe(1);
    // And a second call with the same folder tombstones nothing new.
    expect(await tombstoneMissing(db, sourceId, ['kept.md'], LATER)).toBe(0);
  });
});

describe('touchSource', () => {
  it('records when the folder was last walked', async () => {
    const { id } = await source();
    await touchSource(db, id, LATER);
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
    expect(row.lastSyncedAt).toEqual(LATER);
  });
});
