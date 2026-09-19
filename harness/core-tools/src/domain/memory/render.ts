import type { Db } from '@harness/db';
import { listMemory } from './repository.js';
import type { MemoryEntry, MemoryScope } from './types.js';

const SECTIONS: readonly { title: string; scope: MemoryScope }[] = [
  { title: 'Your notes (principal scope)', scope: 'principal' },
  { title: 'Shared notes (client scope)', scope: 'client' },
];

/**
 * The curated snapshot a run is handed (spec 5.5), as the runtime seeds it at `/memories/MEMORY.md`.
 *
 * A fixed document: one heading, one section per scope in a fixed order, one list item per entry
 * with its id (what `memory_remove` takes), and `(none)` for an empty scope so the model sees
 * both scopes exist. Empty when there is nothing at all — the runtime renders its own
 * "(no memories yet)" for that.
 *
 * Bounded by the two caps, and worth the arithmetic because a runtime budgets on it: 6,500
 * characters of text (2,500 + 4,000), 100 entries each carrying 45 characters of list
 * punctuation and id (`- ` + ` (id: ` + a 36-character uuid + `)`), 100 newlines inside the two
 * sections — one under each heading and one between the lines — two headings of 31 and 30, and
 * 13 more for `# Memory`, the blank line under it, the separator between the sections and the
 * trailing newline. That is 11,174 at both caps, which is the ceiling `render.test.ts` asserts
 * 12,000 against.
 */
export function renderMemorySnapshot(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const sections = SECTIONS.map(({ title, scope }) => {
    const own = entries.filter((e) => e.scope === scope);
    const lines = own.length === 0 ? ['- (none)'] : own.map((e) => `- ${e.text} (id: ${e.id})`);
    return `## ${title}\n${lines.join('\n')}`;
  });
  return `# Memory\n\n${sections.join('\n\n')}\n`;
}

/** What the host puts on `RunRequest.memory`: everything this principal can see, rendered. */
export async function memorySnapshot(db: Db, client: string, principalId: string): Promise<string> {
  return renderMemorySnapshot(await listMemory(db, client, principalId));
}
