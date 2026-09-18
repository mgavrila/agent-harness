import { and, desc, eq, isNotNull, isNull, lte, sql, type InferColumnsDataTypes, type SQL } from 'drizzle-orm';
import { knowledgeChunks, knowledgeDocuments, withTransaction } from '@harness/db';
import type { ToolDeps } from '../tooling/types.js';
import { embedTexts } from './embed.js';
import { KNOWLEDGE_SEARCH_LIMIT, RRF_K, levelRank, type KnowledgeHit } from './types.js';

/** One ranked row, before the two rankings are fused. */
export interface KnowledgeCandidate {
  chunk_id: string;
  document_id: string;
  path: string;
  title: string;
  updated_at: string;
  ordinal: number;
  text: string;
}

/**
 * What this caller may read (spec 5.7, invariant 7): their own client, a document that is not
 * tombstoned, and either a level at or above the chunk's or an explicit grant by principal id.
 *
 * It is a `WHERE` clause and not a filter over a result, which is the whole point: a chunk the
 * caller may not see is never ranked, never counted toward `k`, and never reaches the fusion. A
 * `service` principal's rank is `-1` and so clears nothing on level alone (decision 4).
 */
function visibleTo(deps: ToolDeps): SQL {
  const rank = levelRank(deps.principal.level);
  // Built as one `sql` fragment rather than `and(...)`, which is typed `SQL | undefined` because
  // it is allowed to be handed nothing. It never is here — the three clauses below are literals —
  // so the alternative was a `!` telling the next reader to take that on trust.
  return sql`${eq(knowledgeChunks.client, deps.client)} AND ${isNull(knowledgeDocuments.deletedAt)} AND (${lte(
    knowledgeChunks.minRank,
    rank,
  )} OR ${knowledgeChunks.principals} @> ARRAY[${deps.principal.id}]::text[])`;
}

const COLUMNS = {
  chunkId: knowledgeChunks.id,
  documentId: knowledgeChunks.documentId,
  ordinal: knowledgeChunks.ordinal,
  text: knowledgeChunks.text,
  path: knowledgeDocuments.path,
  title: knowledgeDocuments.title,
  updatedAt: knowledgeDocuments.updatedAt,
};

/**
 * The row shape `COLUMNS` selects, derived from the columns themselves rather than written out
 * beside them. A hand-written copy is a second place to forget: rename a column or widen one to
 * nullable and the copy still compiles, the cast below it still passes, and the mismatch surfaces
 * as a runtime `undefined` somewhere downstream.
 */
type Row = InferColumnsDataTypes<typeof COLUMNS>;

const candidateOf = (row: Row): KnowledgeCandidate => ({
  chunk_id: row.chunkId,
  document_id: row.documentId,
  path: row.path,
  title: row.title,
  updated_at: row.updatedAt.toISOString(),
  ordinal: row.ordinal,
  text: row.text,
});

/**
 * The `k` nearest chunks by cosine distance.
 *
 * `<=>` is pgvector's cosine-distance operator and is what the HNSW index on `embedding` was
 * built for. The vector is bound as a parameter and cast, never interpolated. There is **no
 * distance threshold**: a nearest-neighbour search always answers with its `k` nearest rows,
 * however far away they are, which is why the tool tells the model that a hit is the nearest text
 * rather than an answer.
 *
 * The access filter reaches the plan as the index scan's `Filter`, which is to say the scan walks
 * its nearest candidates and *then* discards the ones this caller may not read. Left alone that
 * costs recall rather than safety — it fails closed, never open — but a member whose visible
 * chunks are a small fraction of a large corpus would get fewer than `k` rows, or none, while
 * visible chunks sat just outside the default `ef_search` of 40. `hnsw.iterative_scan` is
 * pgvector 0.8's answer: the scan resumes and keeps walking until `k` rows survive the filter.
 * `relaxed_order` rather than `strict_order` because the fusion reads a row's *position* and not
 * its distance, so the slight reordering relaxed mode allows costs nothing here and is the faster
 * of the two. It is `SET LOCAL` inside a transaction so the setting dies with the statement's
 * transaction instead of leaning on whatever pooled connection this happened to run on.
 */
async function vectorTopK(deps: ToolDeps, vector: readonly number[], k: number): Promise<KnowledgeCandidate[]> {
  const literal = sql`${`[${vector.join(',')}]`}::vector`;
  return withTransaction(deps.db, async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
    const rows: Row[] = await tx
      .select(COLUMNS)
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(and(visibleTo(deps), isNotNull(knowledgeChunks.embedding)))
      .orderBy(sql`${knowledgeChunks.embedding} <=> ${literal}`)
      .limit(k);
    return rows.map(candidateOf);
  });
}

/**
 * The `k` best chunks by `ts_rank_cd` over the generated `tsv` column.
 *
 * `plainto_tsquery` takes the query as plain words — no operators, so nothing the model writes can
 * widen the match — and a query of stop words alone is the empty query, which matches nothing.
 * `ts_rank_cd` is the cover-density ranking: unlike `ts_rank` it rewards terms appearing close
 * together, which is what spec 5.7 names.
 */
async function lexicalTopK(deps: ToolDeps, query: string, k: number): Promise<KnowledgeCandidate[]> {
  const tsquery = sql`plainto_tsquery('english', ${query})`;
  const rows: Row[] = await deps.db
    .select(COLUMNS)
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(and(visibleTo(deps), sql`${knowledgeChunks.tsv} @@ ${tsquery}`))
    .orderBy(desc(sql`ts_rank_cd(${knowledgeChunks.tsv}, ${tsquery})`))
    .limit(k);
  return rows.map(candidateOf);
}

/**
 * Reciprocal rank fusion: each list contributes `1 / (RRF_K + rank)`, rank counted from 1.
 *
 * Ranks rather than scores, because the two rankings' scores are not comparable — a cosine
 * distance and a cover-density rank are different things measured differently — and the one thing
 * they agree on is order. A chunk both rankings found beats one either found brilliantly, which is
 * the behaviour a hybrid search is for. Ties break on the chunk id so one query always answers in
 * one order.
 */
export function fuseByReciprocalRank(lists: readonly (readonly KnowledgeCandidate[])[], k: number): KnowledgeHit[] {
  const fused = new Map<string, { candidate: KnowledgeCandidate; score: number }>();
  for (const list of lists) {
    list.forEach((candidate, index) => {
      const entry = fused.get(candidate.chunk_id) ?? { candidate, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(candidate.chunk_id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.candidate.chunk_id.localeCompare(b.candidate.chunk_id))
    .slice(0, k)
    .map(({ candidate, score }) => ({ ...candidate, score }));
}

/**
 * Hybrid retrieval over this client's knowledge, at this caller's level (spec 5.7).
 *
 * One embedding call for the query, then the two rankings — both already filtered — then the
 * fusion. The embedding is **not** optional: a lexical-only answer looks exactly like a full one,
 * so a broken `embed` route would quietly halve recall for as long as nobody noticed. It fails
 * loudly instead, with the message `embedTexts` raises.
 *
 * `k` is clamped rather than only capped: the tool's schema already guarantees an integer in
 * range, but this function is exported from the package root and a direct caller passing 0 or a
 * negative would otherwise reach Postgres with it.
 */
export async function searchKnowledge(
  deps: ToolDeps,
  args: { query: string; k: number },
): Promise<{ hits: KnowledgeHit[] }> {
  const k = Math.max(1, Math.min(Math.trunc(args.k), KNOWLEDGE_SEARCH_LIMIT));
  const [vector] = await embedTexts(deps, [args.query]);
  const [byVector, byWord] = await Promise.all([vectorTopK(deps, vector, k), lexicalTopK(deps, args.query, k)]);
  return { hits: fuseByReciprocalRank([byVector, byWord], k) };
}
