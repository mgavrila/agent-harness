import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { memoryEntries, type Db } from '@harness/db';
import { ToolError } from '@harness/shared';
import { assertNoRestrictedPattern } from '../../shared/redaction/patterns.js';
import type { ToolDeps } from '../tooling/types.js';
import { assertNoInjection } from './injection.js';
import {
  MEMORY_CAPS,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_SCOPES,
  type MemoryEntry,
  type MemoryScope,
  type MemoryUsage,
  type ScopeUsage,
} from './types.js';

type Row = typeof memoryEntries.$inferSelect;

function entryOf(row: Row): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    text: row.text,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * What `principalId` may see: their own principal-scope entries and the client's shared ones,
 * and nothing of anyone else's. Every read in this module goes through it, so the filter is the
 * query rather than something applied to a result (invariant 7).
 */
function visibleTo(client: string, principalId: string): (SQL | undefined)[] {
  return [
    eq(memoryEntries.client, client),
    or(
      and(eq(memoryEntries.scope, 'client'), isNull(memoryEntries.principalId)),
      and(eq(memoryEntries.scope, 'principal'), eq(memoryEntries.principalId, principalId)),
    ),
  ];
}

/** Every entry the principal can see, oldest first; one scope of them when `scope` is given. */
export async function listMemory(
  db: Db,
  client: string,
  principalId: string,
  scope?: MemoryScope,
): Promise<MemoryEntry[]> {
  const rows = await db
    .select()
    .from(memoryEntries)
    .where(and(...visibleTo(client, principalId), scope ? eq(memoryEntries.scope, scope) : undefined))
    .orderBy(asc(memoryEntries.createdAt), asc(memoryEntries.id));
  return rows.map(entryOf);
}

/** One entry by id, or null when it does not exist *or* the principal may not see it — the same answer, on purpose. */
export async function findMemoryEntry(
  db: Db,
  client: string,
  principalId: string,
  id: string,
): Promise<MemoryEntry | null> {
  const [row] = await db
    .select()
    .from(memoryEntries)
    .where(and(...visibleTo(client, principalId), eq(memoryEntries.id, id)))
    .limit(1);
  return row ? entryOf(row) : null;
}

export function memoryUsage(entries: readonly MemoryEntry[]): MemoryUsage {
  const usage = {} as MemoryUsage;
  for (const scope of MEMORY_SCOPES) {
    const own = entries.filter((e) => e.scope === scope);
    usage[scope] = {
      used_chars: own.reduce((n, e) => n + e.text.length, 0),
      cap_chars: MEMORY_CAPS[scope].chars,
      entries: own.length,
      cap_entries: MEMORY_CAPS[scope].entries,
    };
  }
  return usage;
}

/**
 * The refusal over a cap (spec 5.5): the scope, the space used and needed, and every current
 * entry with its id, so the model can consolidate in the same turn. The entries are the caller's
 * own or the shared ones — nothing here that `memory_list` would not also return.
 */
function fullMessage(scope: MemoryScope, entries: readonly MemoryEntry[], usage: ScopeUsage, needed: number): string {
  const lines = entries.map((e) => `- (id ${e.id}) ${e.text}`);
  return (
    `memory scope "${scope}" is full: ${usage.used_chars} of ${usage.cap_chars} characters used across ` +
    `${usage.entries} of ${usage.cap_entries} entries, ${needed} needed for this entry; remove or consolidate ` +
    `one with memory_remove, then add again. Current entries:\n${lines.join('\n')}`
  );
}

/** One line per entry, whatever the model typed: the snapshot is a markdown list and a list item is one line. */
function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * Remember one fact. The two scans run before the table is read: an instruction or an invisible
 * character is refused however much room there is (invariant 8), and a restricted identifier
 * never reaches a plaintext column (invariant 10). Then the cap: over it, the refusal carries
 * the current entries. `thread_id` tags where the fact was written from.
 */
export async function addMemory(
  deps: ToolDeps,
  args: { text: string; scope: MemoryScope },
): Promise<{ id: string; scope: MemoryScope; remaining_chars: number }> {
  const text = oneLine(args.text);
  if (text === '' || text.length > MEMORY_ENTRY_MAX_CHARS) {
    throw new ToolError(`memory text must be 1 to ${MEMORY_ENTRY_MAX_CHARS} characters`);
  }
  assertNoInjection(text, 'memory text');
  assertNoRestrictedPattern(text, 'memory text');
  const existing = await listMemory(deps.db, deps.client, deps.principal.id, args.scope);
  const usage = memoryUsage(existing)[args.scope];
  if (usage.used_chars + text.length > usage.cap_chars || usage.entries >= usage.cap_entries) {
    throw new ToolError(fullMessage(args.scope, existing, usage, text.length));
  }
  const [row] = await deps.db
    .insert(memoryEntries)
    .values({
      client: deps.client,
      scope: args.scope,
      principalId: args.scope === 'principal' ? deps.principal.id : null,
      text,
      createdBy: deps.principal.id,
      threadId: deps.context.threadId,
    })
    .returning({ id: memoryEntries.id });
  return { id: row.id, scope: args.scope, remaining_chars: usage.cap_chars - usage.used_chars - text.length };
}

/** Forget one entry the caller can see. An entry they cannot see is "no such entry", not "not yours". */
export async function removeMemory(deps: ToolDeps, id: string): Promise<{ removed: true; scope: MemoryScope }> {
  const entry = await findMemoryEntry(deps.db, deps.client, deps.principal.id, id);
  if (!entry) throw new ToolError(`no memory entry ${id} is visible to you`);
  await deps.db.delete(memoryEntries).where(eq(memoryEntries.id, id));
  return { removed: true, scope: entry.scope };
}
