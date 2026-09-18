import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { searchKnowledge } from '../domain/knowledge/search.js';
import { syncKnowledge } from '../domain/knowledge/sync.js';
import { KNOWLEDGE_DEFAULT_K, KNOWLEDGE_SEARCH_LIMIT } from '../domain/knowledge/types.js';

const HitShape = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  path: z.string(),
  title: z.string(),
  updated_at: z.string(),
  ordinal: z.number(),
  text: z.string(),
  score: z.number(),
});

const knowledgeSearch = defineTool({
  name: 'knowledge_search',
  description:
    'Search this deployment’s knowledge base and get back passages you can cite. Plain words, no operators. ' +
    'Each hit carries the document’s path, title and last-updated time, and the passage itself — quote or ' +
    'paraphrase it and name the path, so the reader can check it. You only ever see documents your level or an ' +
    'explicit grant allows, so an answer you cannot support here is one you should say you do not have. ' +
    'A hit is the nearest passage to your words, not a guarantee that it answers them: read it before you use it.',
  actionClass: 'read',
  input: z.object({
    query: z.string().min(2).max(500),
    k: z.number().int().min(1).max(KNOWLEDGE_SEARCH_LIMIT).default(KNOWLEDGE_DEFAULT_K),
  }),
  output: z.object({ hits: z.array(HitShape) }),
  handler: async (args, deps) => searchKnowledge(deps, args),
});

const knowledgeSync = defineTool({
  name: 'knowledge_sync',
  description:
    'Re-read this deployment’s knowledge folder into the knowledge base: new and changed documents are ' +
    'chunked and embedded again, and a document whose file is gone stops being searchable. Reports how many ' +
    'documents were scanned, added, updated, left alone and removed, how many passages were written, and any ' +
    'document that was skipped, with its kind of trouble and the reason.',
  // `write.internal`, not `admin`: this rewrites the knowledge tables from files a human already
  // controls, which is a write to the record store, while `admin` is "changes who may do what" and
  // is `blocked` for every level but `admin` — including `service`, the level every scheduled job
  // runs at. A sync that only an admin could call is a sync no playbook could ever perform, and
  // the nightly refresh is the whole point of the folder. Under the default matrix this lands
  // parked for a member and automatic for a practitioner and above and for a service principal.
  actionClass: 'write.internal',
  input: z.object({}),
  output: z.object({
    source: z.string(),
    scanned: z.number(),
    added: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    removed: z.number(),
    chunks: z.number(),
    skipped: z.array(z.object({ path: z.string(), kind: z.enum(['restricted', 'embed_failed']), reason: z.string() })),
  }),
  handler: async (_args, deps) => syncKnowledge(deps),
});

export const knowledgeTools: AnyToolDef[] = [knowledgeSearch, knowledgeSync];
