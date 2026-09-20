import path from 'node:path';
import { sql } from 'drizzle-orm';
import { withTransaction } from '@harness/db';
import { ToolError } from '@harness/shared';
import { containsRestrictedPattern } from '../../shared/redaction/patterns.js';
import type { ToolDeps } from '../tooling/types.js';
import { chunkText } from './chunk.js';
import { readKnowledgeFolder } from './document.js';
import { embedTexts } from './embed.js';
import {
  findDocumentState,
  findOrCreateSource,
  isUnchanged,
  replaceChunks,
  tombstoneMissing,
  touchSource,
  upsertDocument,
} from './repository.js';
import {
  KNOWLEDGE_SOURCE_KIND,
  KNOWLEDGE_SOURCE_NAME,
  type KnowledgeSyncResult,
  type ParsedKnowledgeDocument,
} from './types.js';

/** The one refusal a document can earn, in the register every other refusal uses: a category, never the text. */
const RESTRICTED_REASON = 'it contains a restricted identifier; remove it from the document and sync again';

/**
 * Why a document did not make it past the embedder.
 *
 * The gateway's own words are repeated, and they are safe to repeat: `embed.ts` builds a
 * `ToolError` from the route name and the HTTP status and never from the text that was sent,
 * precisely so the message can travel this far.
 */
function embedFailureReason(err: ToolError): string {
  return `it could not be embedded, so it was left exactly as it was and the next sync will try it again: ${err.message}`;
}

/**
 * Everything about a document that must not reach a chunk row, a citation or a run event
 * (invariant 10): its text, its title, and its path — which `knowledge_search` returns so the
 * model can cite it, and which therefore travels exactly as far as the text does.
 */
function isRestricted(doc: ParsedKnowledgeDocument, chunks: readonly string[]): boolean {
  return (
    containsRestrictedPattern(doc.path) ||
    containsRestrictedPattern(doc.title) ||
    chunks.some((chunk) => containsRestrictedPattern(chunk))
  );
}

/**
 * Walk the client's knowledge folder into the tables (spec 5.7).
 *
 * The shape of one pass: read every markdown file, upsert each one by `(source, path)`, re-chunk
 * and re-embed only the ones whose hash moved, tombstone the ones whose files are gone, and stamp
 * the source. Nothing is deleted outright and no other client's rows are touched, because every
 * statement is scoped to this client's source row.
 *
 * Invariant 10 is enforced here, before anything is written: a document whose path, title or text
 * trips the restricted-pattern check contributes no chunks and its row is left exactly as it was —
 * a new one is not added, an old one is not updated and not tombstoned — and its path comes back
 * in `skipped`, so one bad file is a line in the result rather than a folder that will not sync.
 *
 * The order of the three steps per document is the load-bearing part. The stored hash is **read**
 * before the embed and **written** with the chunks it produced, in one transaction, never before:
 * the hash is what decides whether a document is ever embedded again, so storing it while the
 * chunks still belong to the previous generation would make the failure permanent and silent —
 * the next sync would call the document unchanged, and a document whose `min_level` had just been
 * raised would keep serving chunks at the old level, which is invariant 7 defeated in the unsafe
 * direction. Written this way, a failed embed leaves the previous row and the previous chunks
 * exactly where they were and the next sync retries the document.
 *
 * The embed itself is outside that transaction, and each document gets its own rather than the
 * folder sharing one: a batch of embeddings is a network call, and a transaction held open across
 * a network call is a lock held for as long as the gateway feels like taking.
 *
 * A gateway that refuses one document does not end the sync. The document is named in `skipped`
 * with the reason, and every other document in the folder is synced — the same rule the restricted
 * check follows, and the one that matters most when the refusal is a daily budget that would
 * otherwise leave the whole folder on yesterday's content.
 */
export async function syncKnowledge(deps: ToolDeps, opts: { dir?: string } = {}): Promise<KnowledgeSyncResult> {
  const dir = opts.dir ?? deps.knowledgeDir;
  if (dir === null) {
    throw new ToolError(
      "this client keeps its knowledge in the store, not in a directory; the document's `knowledge` section decides which",
    );
  }
  const now = deps.now();
  // A stable, readable label on the `knowledge_sources` row rather than the absolute path, which
  // differs between a checkout and a container and would rewrite the row on every start for no
  // reason. Nothing opens it: `dir` above is what is read. It still spells the layout a client
  // had when clients lived in this repository, and goes on spelling it: the label is part of the
  // row's identity, so changing it would rewrite every existing row to say the same thing
  // differently.
  const location = opts.dir ?? path.posix.join('clients', deps.client, 'knowledge');
  const { id: sourceId } = await findOrCreateSource(
    deps.db,
    deps.client,
    { name: KNOWLEDGE_SOURCE_NAME, kind: KNOWLEDGE_SOURCE_KIND, location },
    now,
  );

  const documents = await readKnowledgeFolder(dir);
  const result: KnowledgeSyncResult = {
    source: KNOWLEDGE_SOURCE_NAME,
    scanned: documents.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    chunks: 0,
    skipped: [],
  };
  // Every path that was on disk this pass, skipped ones included: a document refused for a
  // restricted identifier must not then be tombstoned as if its file had been deleted.
  const seen: string[] = [];

  for (const doc of documents) {
    seen.push(doc.path);
    const chunks = chunkText(doc.body);
    if (isRestricted(doc, chunks)) {
      result.skipped.push({ path: doc.path, kind: 'restricted', reason: RESTRICTED_REASON });
      continue;
    }
    if (isUnchanged(await findDocumentState(deps.db, sourceId, doc.path), doc)) {
      result.unchanged += 1;
      continue;
    }

    let vectors: number[][];
    try {
      vectors = await embedTexts(deps, chunks);
    } catch (err) {
      // Only the gateway's own refusal is a skip. Anything else — a bug in this package, a
      // database that would not take the attribution row — is not something the next sync will
      // heal, and reporting it as a skipped document would hand an operator a line saying to
      // wait for a retry that fixes nothing. It comes out of the sync instead.
      if (!(err instanceof ToolError)) throw err;
      result.skipped.push({ path: doc.path, kind: 'embed_failed', reason: embedFailureReason(err) });
      continue;
    }

    // The row and its chunks together, so the hash and the chunks it describes are never two
    // separately observable writes, and the whole write behind a lock on this one document.
    //
    // The lock is what stops two syncs of one document interleaving. `knowledge_sync` is a tool a
    // practitioner can run from a chat turn while the nightly playbook is running it on another
    // thread — or another host — and `serialize` is per thread, so nothing above this covers it.
    // Unserialised, the two delete each other's chunks and insert their own: under READ COMMITTED
    // a DELETE that waited on a concurrent transaction re-checks the rows of its own snapshot and
    // never sees the rows that transaction added, so the document can end with two live
    // generations and stay that way until its file changes, `knowledge_search` returning the same
    // passage twice.
    //
    // `pg_advisory_xact_lock` in its two-integer form, keyed on the source id and the path — the
    // pair `knowledge_documents_source_path_uq` is built on — rather than on a hash of the two
    // joined, so a collision takes both halves colliding. It is transaction-scoped, so the commit
    // or the rollback releases it and no path out of this function can leave it held.
    const outcome = await withTransaction(deps.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sourceId}), hashtext(${doc.path}))`);
      const { id, change } = await upsertDocument(tx, { client: deps.client, sourceId, doc, now });
      return {
        change,
        written: await replaceChunks(tx, { documentId: id, client: deps.client, doc, chunks, vectors }),
      };
    });
    result.chunks += outcome.written;
    if (outcome.change === 'added') result.added += 1;
    else result.updated += 1;
  }

  result.removed = await tombstoneMissing(deps.db, sourceId, seen, now);
  await touchSource(deps.db, sourceId, now);
  return result;
}
