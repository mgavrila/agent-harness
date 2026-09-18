import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { addMemory, findMemoryEntry, listMemory, memoryUsage, removeMemory } from '../domain/memory/repository.js';
import { searchSessions } from '../domain/memory/search.js';
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_SCOPES, SESSION_SEARCH_LIMIT } from '../domain/memory/types.js';
import { containsRestrictedPattern } from '../shared/redaction/patterns.js';

const ScopeShape = z.enum(MEMORY_SCOPES);
const EntryShape = z.object({
  id: z.string(),
  scope: ScopeShape,
  text: z.string(),
  created_by: z.string(),
  created_at: z.string(),
});
const UsageShape = z.object({
  used_chars: z.number(),
  cap_chars: z.number(),
  entries: z.number(),
  cap_entries: z.number(),
});

const memoryAdd = defineTool({
  name: 'memory_add',
  description:
    'Remember one fact for later conversations. `scope: "principal"` (the default) is your own notes, seen only when you act; ' +
    '`scope: "client"` is shared with everyone in this deployment. Each scope has a fixed size: over it the call is refused ' +
    'with the current entries, so consolidate with memory_remove and add again. A fact, never a direction: text that reads ' +
    'as an instruction to the assistant is refused, and so is a restricted identifier.',
  actionClass: 'write.self',
  // Own scope is `write.self` for every level; the shared scope is a write to the deployment.
  actionClassFor: ({ scope }) => (scope === 'client' ? 'write.internal' : 'write.self'),
  input: z.object({
    text: z.string().min(1).max(MEMORY_ENTRY_MAX_CHARS),
    scope: ScopeShape.default('principal'),
  }),
  output: z.object({ id: z.string(), scope: ScopeShape, remaining_chars: z.number() }),
  handler: async (args, deps) => addMemory(deps, args),
  // A parked write stores its arguments as plaintext jsonb; the handler's own check has not run yet.
  redact: ({ text, scope }) => ({ scope, text: containsRestrictedPattern(text) ? '(withheld)' : text }),
});

const memoryRemove = defineTool({
  name: 'memory_remove',
  description:
    'Forget one memory entry by its id (from memory_list or the memory file). Your own entries, or a shared one.',
  actionClass: 'write.self',
  actionClassFor: async ({ id }, deps) =>
    (await findMemoryEntry(deps.db, deps.client, deps.principal.id, id))?.scope === 'client'
      ? 'write.internal'
      : 'write.self',
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ removed: z.literal(true), scope: ScopeShape }),
  handler: async ({ id }, deps) => removeMemory(deps, id),
});

const memoryList = defineTool({
  name: 'memory_list',
  description:
    'Every memory entry you can see — your own principal scope and the shared client scope — with how much of each scope is used.',
  actionClass: 'read',
  input: z.object({ scope: ScopeShape.optional() }),
  output: z.object({ entries: z.array(EntryShape), usage: z.object({ principal: UsageShape, client: UsageShape }) }),
  handler: async ({ scope }, deps) => {
    const all = await listMemory(deps.db, deps.client, deps.principal.id);
    return { entries: scope ? all.filter((e) => e.scope === scope) : all, usage: memoryUsage(all) };
  },
});

const sessionSearch = defineTool({
  name: 'session_search',
  description:
    'Full-text search over earlier conversations you took part in (and, for a lead or above, the scheduled playbook threads). ' +
    'Plain words, no operators. Ranked; at most 20 hits, each a thread id, a time, a role and a short snippet.',
  actionClass: 'read',
  input: z.object({
    query: z.string().min(2).max(200),
    limit: z.number().int().min(1).max(SESSION_SEARCH_LIMIT).default(SESSION_SEARCH_LIMIT),
  }),
  output: z.object({
    hits: z.array(z.object({ thread_id: z.string(), created_at: z.string(), role: z.string(), snippet: z.string() })),
  }),
  handler: async (args, deps) => searchSessions(deps, args),
});

export const memoryTools: AnyToolDef[] = [memoryAdd, memoryRemove, memoryList, sessionSearch];
