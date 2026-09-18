import { and, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { knowledgeChunks, knowledgeDocuments, knowledgeSources, withTransaction, type Db } from '@harness/db';
import type { ParsedKnowledgeDocument } from './types.js';

/** What one file did to its row this sync. `unchanged` is the case that skips the embedder. */
export type DocumentChange = 'added' | 'updated' | 'unchanged';

/**
 * The client's one source row, by name. `location` is refreshed on every call so a deployment
 * that moved its folder says where it is now; nothing reads it but a human.
 */
export async function findOrCreateSource(
  db: Db,
  client: string,
  spec: { name: string; kind: string; location: string },
  now: Date,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(knowledgeSources)
    .values({ client, name: spec.name, kind: spec.kind, location: spec.location, updatedAt: now })
    .onConflictDoUpdate({
      target: [knowledgeSources.client, knowledgeSources.name],
      set: { kind: spec.kind, location: spec.location, updatedAt: now },
    })
    .returning({ id: knowledgeSources.id });
  return row;
}

/**
 * What is already stored for one file, or `undefined` when the folder has never held it.
 *
 * Separate from `upsertDocument` so a caller can decide whether a document changed *before* it
 * embeds: the hash must not be written until the chunks that go with it are, or a document whose
 * embedding failed would be reported unchanged for ever (the write half of that is one
 * transaction in `syncKnowledge`).
 */
export async function findDocumentState(
  db: Db,
  sourceId: string,
  documentPath: string,
): Promise<{ id: string; sha256: string; deletedAt: Date | null } | undefined> {
  const [row] = await db
    .select({ id: knowledgeDocuments.id, sha256: knowledgeDocuments.sha256, deletedAt: knowledgeDocuments.deletedAt })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.path, documentPath)))
    .limit(1);
  return row;
}

/** True when what is stored for a file is this exact file, live. The one test that skips the embedder. */
export function isUnchanged(
  existing: { sha256: string; deletedAt: Date | null } | undefined,
  doc: ParsedKnowledgeDocument,
): boolean {
  return existing !== undefined && existing.sha256 === doc.sha256 && existing.deletedAt === null;
}

/**
 * One file's row, keyed by `(source_id, path)`.
 *
 * The decision to re-embed is `sha256` alone, and that hash covers the frontmatter too — so
 * raising a document's `min_level` re-chunks it, which is what puts the new level on every chunk,
 * where the access filter reads it (decision 8). A tombstoned document whose file has come back is
 * an `updated`, not an `added`: the id is the same and nothing that pointed at it has to move.
 *
 * One statement, `ON CONFLICT` on the unique constraint the table already carries, rather than a
 * select followed by an insert: two syncs of one folder both find no row, both insert, and the
 * second earns a unique violation that is nobody's `ToolError` and so comes out of the sync. Here
 * the loser of that race updates instead, whether or not it holds the lock `syncKnowledge` takes.
 *
 * `xmax = 0` on the returned row is how Postgres answers "was this an insert or an update": an
 * inserted row has no deleting transaction, an updated one carries the updating transaction's id.
 * The `setWhere` leaves an identical, live document alone — `updated_at` included, because that
 * column is when the content last changed and a citation shows it — and an update that touches
 * nothing returns no row, which is `unchanged`.
 */
export async function upsertDocument(
  db: Db,
  input: { client: string; sourceId: string; doc: ParsedKnowledgeDocument; now: Date },
): Promise<{ id: string; change: DocumentChange }> {
  const { client, sourceId, doc, now } = input;
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({
      client,
      sourceId,
      path: doc.path,
      title: doc.title,
      sha256: doc.sha256,
      minLevel: doc.minLevel,
      minRank: doc.minRank,
      principals: doc.principals,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [knowledgeDocuments.sourceId, knowledgeDocuments.path],
      set: {
        title: doc.title,
        sha256: doc.sha256,
        minLevel: doc.minLevel,
        minRank: doc.minRank,
        principals: doc.principals,
        updatedAt: now,
        deletedAt: null,
      },
      setWhere: sql`${knowledgeDocuments.sha256} IS DISTINCT FROM ${doc.sha256} OR ${knowledgeDocuments.deletedAt} IS NOT NULL`,
    })
    .returning({ id: knowledgeDocuments.id, inserted: sql<boolean>`(xmax = 0)` });
  if (row) return { id: row.id, change: row.inserted ? 'added' : 'updated' };

  // No row back: the conflict fired and the update matched nothing, so what is stored is this
  // exact file, live. The row is certainly there — the conflict is what brought us here — and
  // this read is only for its id.
  const existing = await findDocumentState(db, sourceId, doc.path);
  if (!existing) throw new Error(`knowledge document ${doc.path} conflicted with a row that is not there`);
  return { id: existing.id, change: 'unchanged' };
}

/**
 * Replace a document's chunks, in one transaction, with the access rules copied onto each of them.
 *
 * Copied rather than joined on purpose: `knowledge_search` puts the access filter in the same
 * WHERE clause as the ranking, so a chunk the caller may not see is never ranked (invariant 7),
 * and a join would put that filter one step too late.
 */
export async function replaceChunks(
  db: Db,
  input: {
    documentId: string;
    client: string;
    doc: ParsedKnowledgeDocument;
    chunks: readonly string[];
    vectors: readonly number[][];
  },
): Promise<number> {
  const { documentId, client, doc, chunks, vectors } = input;
  return withTransaction(db, async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
    if (chunks.length === 0) return 0;
    await tx.insert(knowledgeChunks).values(
      chunks.map((text, ordinal) => ({
        documentId,
        client,
        ordinal,
        text,
        embedding: vectors[ordinal],
        minLevel: doc.minLevel,
        minRank: doc.minRank,
        principals: doc.principals,
      })),
    );
    return chunks.length;
  });
}

/**
 * Tombstone every live document of this source whose path is no longer in the folder, and delete
 * its chunks.
 *
 * The row stays so an operator can see what used to be there and when it went; the chunks go so
 * nothing can retrieve it. `keep` empty means the folder is empty, which is a legitimate state —
 * an operator who deleted the folder's contents meant it — so the `NOT IN` is simply dropped
 * rather than producing the empty-list SQL drizzle cannot build.
 */
export async function tombstoneMissing(db: Db, sourceId: string, keep: readonly string[], now: Date): Promise<number> {
  const live: (SQL | undefined)[] = [eq(knowledgeDocuments.sourceId, sourceId), isNull(knowledgeDocuments.deletedAt)];
  if (keep.length > 0) live.push(notInArray(knowledgeDocuments.path, [...keep]));
  return withTransaction(db, async (tx) => {
    const gone = await tx
      .update(knowledgeDocuments)
      .set({ deletedAt: now })
      .where(and(...live))
      .returning({ id: knowledgeDocuments.id });
    if (gone.length === 0) return 0;
    await tx.delete(knowledgeChunks).where(
      inArray(
        knowledgeChunks.documentId,
        gone.map((row) => row.id),
      ),
    );
    return gone.length;
  });
}

/** When this source was last walked, whatever the walk found. */
export async function touchSource(db: Db, sourceId: string, now: Date): Promise<void> {
  await db.update(knowledgeSources).set({ lastSyncedAt: now, updatedAt: now }).where(eq(knowledgeSources.id, sourceId));
}
