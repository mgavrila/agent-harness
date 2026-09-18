/**
 * Curated memory (spec 5.5): facts a principal or a deployment keeps between conversations.
 *
 * Two scopes. `principal` is one principal's own notes — a person's, or a service's — and is
 * visible only when that principal acts (invariant 7). `client` is shared by everyone the
 * deployment serves. Each scope has a fixed size in characters *and* entries; the entry cap is
 * what bounds the rendered snapshot, because every entry carries its id.
 */
export const MEMORY_SCOPES = ['principal', 'client'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_CAPS: Readonly<Record<MemoryScope, { readonly chars: number; readonly entries: number }>> = {
  principal: { chars: 2_500, entries: 50 },
  client: { chars: 4_000, entries: 50 },
};

/** One remembered fact is a sentence or two, never a document. */
export const MEMORY_ENTRY_MAX_CHARS = 500;

/** The most hits `session_search` returns. */
export const SESSION_SEARCH_LIMIT = 20;

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  text: string;
  created_by: string;
  created_at: string;
}

export interface ScopeUsage {
  used_chars: number;
  cap_chars: number;
  entries: number;
  cap_entries: number;
}

export type MemoryUsage = Record<MemoryScope, ScopeUsage>;

/** One hit of episodic recall: where it was said, when, by which role, and the matching window. */
export interface SessionHit {
  thread_id: string;
  created_at: string;
  role: string;
  snippet: string;
}
