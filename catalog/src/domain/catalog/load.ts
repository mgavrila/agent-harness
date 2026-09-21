import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Blueprint } from '@harness/config-api';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';
import { parseWithIncludes } from '../../shared/include.js';
import { CatalogMetaShape } from './meta.js';
import type { Catalog, LoadedBlueprint } from './types.js';

const BLUEPRINT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

// `@harness/config-api`'s `index.ts` does not re-export `BlueprintShape` (only `resolve.ts`
// declares it). Validated locally until the kernel re-exports it; see
// ~/Downloads/hf1/kernel-followups-from-platform.md. This local shape is a platform shape, not
// copied kernel code — it only checks the blueprint envelope, not the document's contents.
const LocalBlueprintShape = z.object({
  document: z.record(z.string(), z.unknown()),
  lockset: z.array(z.string()),
  version: z.string().min(1),
});

function invalid(what: string, error: z.ZodError): ConfigError {
  return new ConfigError(`${what} is invalid: ${z.prettifyError(error)}`);
}

async function loadOne(root: string, name: string): Promise<LoadedBlueprint> {
  if (!BLUEPRINT_NAME.test(name))
    throw new ConfigError(`"${name}" is not a blueprint name (lowercase, digits, hyphens)`);
  const dir = path.join(root, name);
  const rawBlueprint = await parseWithIncludes(path.join(dir, 'blueprint.yaml'));
  const parsedBlueprint = LocalBlueprintShape.safeParse(rawBlueprint);
  if (!parsedBlueprint.success) throw invalid(`blueprint ${name}`, parsedBlueprint.error);
  const rawMeta = await parseWithIncludes(path.join(dir, 'catalog.yaml'));
  const parsedMeta = CatalogMetaShape.safeParse(rawMeta);
  if (!parsedMeta.success) throw invalid(`blueprint ${name}: catalog.yaml`, parsedMeta.error);
  const changelog = await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
  let knowledgeSeeds: string[] = [];
  try {
    knowledgeSeeds = (await readdir(path.join(dir, 'knowledge'))).filter((f) => !f.startsWith('.')).sort();
  } catch {
    knowledgeSeeds = [];
  }
  return {
    name,
    version: parsedBlueprint.data.version,
    dir,
    // `LocalBlueprintShape` only validates the envelope (document/lockset/version), not the
    // document's contents, since `BlueprintShape` isn't re-exported to validate against (see
    // the follow-up above) — so this cast goes through `unknown` rather than a direct one.
    blueprint: parsedBlueprint.data as unknown as Blueprint,
    meta: parsedMeta.data,
    changelog,
    knowledgeSeeds,
  };
}

/** Every `<dir>/<name>/` is a blueprint. Names are the directory names; order is alphabetical. */
export async function loadCatalog(dir: string): Promise<Catalog> {
  const entries = (await readdir(dir)).sort();
  const loaded = new Map<string, LoadedBlueprint>();
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (!(await stat(path.join(dir, entry))).isDirectory()) continue;
    loaded.set(entry, await loadOne(dir, entry));
  }
  return {
    list: () => [...loaded.values()],
    get: (name) => {
      const found = loaded.get(name);
      if (!found) throw new ConfigError(`no blueprint named "${name}"`);
      return found;
    },
  };
}
