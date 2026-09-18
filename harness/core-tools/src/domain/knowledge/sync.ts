import path from 'node:path';
import { containsRestrictedPattern } from '../../shared/redaction/patterns.js';
import type { ToolDeps } from '../tooling/types.js';
import { chunkText } from './chunk.js';
import { readKnowledgeFolder } from './document.js';
import { embedTexts } from './embed.js';
import { findOrCreateSource, replaceChunks, tombstoneMissing, touchSource, upsertDocument } from './repository.js';
import { KNOWLEDGE_SOURCE_KIND, KNOWLEDGE_SOURCE_NAME, type KnowledgeSyncResult } from './types.js';

/** The one refusal a document can earn, in the register every other refusal uses: a category, never the text. */
const RESTRICTED_REASON = 'it contains a restricted identifier; remove it from the document and sync again';

/**
 * Walk the client's knowledge folder into the tables (spec 5.7).
 *
 * The shape of one pass: read every markdown file, upsert each one by `(source, path)`, re-chunk
 * and re-embed only the ones whose hash moved, tombstone the ones whose files are gone, and stamp
 * the source. Nothing is deleted outright and no other client's rows are touched, because every
 * statement is scoped to this client's source row.
 *
 * Invariant 10 is enforced here, before anything is written: a document whose title or whose text
 * trips the restricted-pattern check contributes no chunks and its row is left exactly as it was —
 * a new one is not added, an old one is not updated and not tombstoned — and its path comes back
 * in `skipped`, so one bad file is a line in the result rather than a folder that will not sync.
 *
 * Each document's chunks are replaced in their own transaction rather than the whole folder in
 * one: a batch of embeddings is a network call, and a transaction held open across a network call
 * is a lock held for as long as the gateway feels like taking.
 */
export async function syncKnowledge(deps: ToolDeps, opts: { dir?: string } = {}): Promise<KnowledgeSyncResult> {
  const dir = opts.dir ?? path.join(deps.clientDir, 'knowledge');
  const now = deps.now();
  // A stable, readable location rather than the absolute path, which differs between a checkout
  // and a container and would rewrite the row on every start for no reason.
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
    if (containsRestrictedPattern(doc.title) || chunks.some((chunk) => containsRestrictedPattern(chunk))) {
      result.skipped.push({ path: doc.path, reason: RESTRICTED_REASON });
      continue;
    }
    const { id, change } = await upsertDocument(deps.db, { client: deps.client, sourceId, doc, now });
    if (change === 'unchanged') {
      result.unchanged += 1;
      continue;
    }
    const vectors = await embedTexts(deps, chunks);
    result.chunks += await replaceChunks(deps.db, { documentId: id, client: deps.client, doc, chunks, vectors });
    if (change === 'added') result.added += 1;
    else result.updated += 1;
  }

  result.removed = await tombstoneMissing(deps.db, sourceId, seen, now);
  await touchSource(deps.db, sourceId, now);
  return result;
}
