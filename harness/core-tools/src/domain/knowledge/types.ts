import { USER_LEVELS, type Level } from '@harness/shared';

/**
 * The knowledge base (spec 5.7): a client's own markdown, chunked, embedded and retrievable by
 * whoever the document's frontmatter lets read it.
 *
 * One source per client today — the `knowledge/` folder of `clients/<name>/` — named here rather
 * than derived, because a second kind (a wiki, a share) is a second row with this same shape and
 * nothing below it changes.
 */
export const KNOWLEDGE_SOURCE_NAME = 'client-folder';
export const KNOWLEDGE_SOURCE_KIND = 'folder';

/** The most hits `knowledge_search` will return, and the default when the caller says nothing. */
export const KNOWLEDGE_SEARCH_LIMIT = 20;
export const KNOWLEDGE_DEFAULT_K = 5;

/**
 * The constant in reciprocal rank fusion: `score += 1 / (RRF_K + rank)`, rank counted from 1 in
 * each ranking. 60 is the value the method was published with and the one every implementation
 * since has carried; it damps the difference between the first and second hit of a list enough
 * that a chunk found by both rankings beats one found brilliantly by either. Not a knob.
 */
export const RRF_K = 60;

/**
 * What a principal off the level ladder ranks as (decision 4).
 *
 * `service` is not a user level — `levelAtLeast('service', 'member')` is false — and the user
 * levels start at 0, so anything below them clears nothing: `min_rank <= -1` matches no chunk, and
 * a scheduled job reads a knowledge document only when the document names its principal id.
 */
export const SERVICE_RANK = -1;

/**
 * A level as a number the database can compare (decision 3).
 *
 * The four user levels are a ladder: `member` 0 through `admin` 3, so `min_rank <= $rank` is
 * exactly "this level or above". `indexOf` answers `-1` for anything not on that ladder, which is
 * `SERVICE_RANK` already — the one value that is deliberately what the miss returns.
 */
export function levelRank(level: Level): number {
  return (USER_LEVELS as readonly string[]).indexOf(level);
}

/** One markdown file, read and validated, ready to be upserted and chunked. */
export interface ParsedKnowledgeDocument {
  /** Relative to the source's root, forward slashes, e.g. `policies/front-desk.md`. */
  path: string;
  title: string;
  minLevel: Level;
  minRank: number;
  principals: string[];
  /** sha256 of the file's whole text, frontmatter included: the key that decides a re-embed. */
  sha256: string;
  /** The text below the frontmatter, trimmed. What is chunked. */
  body: string;
}

/** One retrieved chunk, with everything the model needs to cite it. */
export interface KnowledgeHit {
  chunk_id: string;
  document_id: string;
  path: string;
  title: string;
  updated_at: string;
  ordinal: number;
  text: string;
  /** The fused reciprocal-rank score. Comparable within one answer, and meaningless across two. */
  score: number;
}

/** What one `knowledge_sync` did. `skipped` names a document that was refused, and why. */
export interface KnowledgeSyncResult {
  source: string;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Chunks written this run, across added and updated documents. */
  chunks: number;
  skipped: { path: string; reason: string }[];
}
