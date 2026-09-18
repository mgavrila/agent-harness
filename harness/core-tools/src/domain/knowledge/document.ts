import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { PRINCIPAL_ID_PATTERN } from '@harness/identity-api';
import { ConfigError, USER_LEVELS, type Level } from '@harness/shared';
import { levelRank, type ParsedKnowledgeDocument } from './types.js';

/**
 * A knowledge document's frontmatter (spec 5.7).
 *
 * `min_level` is one of the four *user* levels and never `service`: a level is a ladder a person
 * climbs, and a scheduled job is not on it, so a document a service may read names that service in
 * `principals` (decision 4). `.strict()` for the same reason a routing file is strict — a typo in
 * an access rule must fail loudly rather than be dropped and leave a document more readable than
 * its author meant.
 */
const FrontmatterShape = z
  .object({
    title: z.string().min(1).max(200).optional(),
    min_level: z.enum(USER_LEVELS).default('member'),
    principals: z
      .array(z.string().regex(PRINCIPAL_ID_PATTERN, 'a principal id is u-<slug> or svc-<slug>'))
      .max(50)
      .default([]),
  })
  .strict();

/** The YAML object between the first two `---` lines, when there is one. The same shape `SKILL.md` uses. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function titleFrom(body: string, relPath: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return path.basename(relPath, path.extname(relPath));
}

/**
 * One markdown file into the row and the chunks it becomes.
 *
 * The hash covers the **whole** text, frontmatter included, so that changing `min_level` or
 * `principals` without touching a word of the body still re-syncs the document — and the copies of
 * those values on every chunk, which is what the access filter reads, move with it (decision 8).
 */
export function parseKnowledgeDocument(relPath: string, text: string): ParsedKnowledgeDocument {
  const match = FRONTMATTER.exec(text);
  const raw: unknown = match ? (parseYaml(match[1]) ?? {}) : {};
  const parsed = FrontmatterShape.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`knowledge document "${relPath}" has invalid frontmatter: ${z.prettifyError(parsed.error)}`);
  }
  const body = (match ? text.slice(match[0].length) : text).trim();
  if (body === '') throw new ConfigError(`knowledge document "${relPath}" is empty`);
  const minLevel: Level = parsed.data.min_level;
  return {
    path: relPath,
    title: parsed.data.title ?? titleFrom(body, relPath),
    minLevel,
    minRank: levelRank(minLevel),
    principals: parsed.data.principals,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    body,
  };
}

/** Every `.md` under `dir`, relative path first, dot-directories skipped. */
async function markdownFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    // `.git`, `.DS_Store` and friends, and a nested checkout: none of them is a client's knowledge.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await markdownFiles(path.join(dir, entry.name), relative)));
    else if (entry.name.endsWith('.md')) found.push(relative);
  }
  return found;
}

/**
 * Read a whole knowledge folder, in path order so a sync is deterministic.
 *
 * A folder that is not there is an **empty list**, not an error: a client with no knowledge base
 * is an ordinary client, and `knowledge_sync` says so in its result rather than failing.
 */
export async function readKnowledgeFolder(dir: string): Promise<ParsedKnowledgeDocument[]> {
  let paths: string[];
  try {
    paths = await markdownFiles(dir);
  } catch {
    return [];
  }
  const documents: ParsedKnowledgeDocument[] = [];
  for (const relative of paths) {
    documents.push(parseKnowledgeDocument(relative, await readFile(path.join(dir, relative), 'utf8')));
  }
  return documents;
}
