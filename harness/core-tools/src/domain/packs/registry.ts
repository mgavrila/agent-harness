import { ConfigError } from '@harness/shared';
import type { Pack } from '@harness/pack-api';
import { parseManifest } from '../documents/manifest.js';
import type { PackRegistry } from './types.js';

/**
 * A registry over packs that are already in hand. `makeTestDeps` and the surface recorder use
 * it, and `loadPacks` below builds one over whatever it resolved.
 *
 * `manifest()` returns each pack's extraction manifest **parsed**, not the raw value off
 * `Pack.extraction`. `Pack.extraction` is typed `ProviderManifest`, but a pack is free to hand
 * in the raw JSON a human edits — `packs/healthcare/src/index.ts` casts `provider.json` rather
 * than validating it — and the raw value is missing the zod defaults `buildExtractionSchema`
 * depends on (`restricted: false`, `source: 'model'`). Parsing here, once, at construction, is
 * what makes those defaults exist no matter which pack, or which test, built this registry;
 * validating the manifest against *this build's* restricted-name rules rather than the pack's
 * matters too, because those rules decide what gets encrypted, so they belong to whoever does
 * the encrypting. A pack shipped against an older rule set fails here, at startup, named.
 */
export function registryOf(all: Pack[]): PackRegistry {
  const manifests = all.map((p) => parseManifest(p.extraction));
  return {
    all,
    byName(name) {
      const found = all.find((p) => p.name === name);
      if (!found) throw new ConfigError(`no pack named "${name}" is loaded`);
      return found;
    },
    documentKinds: () => [...new Set(all.flatMap((p) => [...p.documentKinds]))],
    manifest: () => manifests[0],
    formsDir: () => all[0].formsDir,
    skillsDirs: () => all.map((p) => p.skillsDir),
  };
}

/**
 * Load the packs `HARNESS_PACKS` names.
 *
 * The specifier is a variable, so this is the one place in core-tools that reaches a pack at
 * all, and it reaches it the way a plug-in host does: by name, at startup, with no build-time
 * edge. `pnpm arch` forbids a static `@harness/pack-*` import anywhere else under `src/`.
 *
 * Every failure before `registryOf` is a `ConfigError` naming the module and nothing else. A
 * resolver error's message carries absolute filesystem paths and a node_modules layout, and
 * this message can end up in a container log an operator pastes into a ticket. `registryOf`
 * itself parses each pack's manifest — see its comment — so a malformed one fails here too,
 * named, rather than silently reaching `documents_extract` with its defaults missing.
 */
export async function loadPacks(names: string[]): Promise<PackRegistry> {
  if (names.length === 0) throw new ConfigError('HARNESS_PACKS names no pack; at least one is required');
  const all: Pack[] = [];
  for (const name of names) {
    let module: { pack?: Pack };
    try {
      module = (await import(name)) as { pack?: Pack };
    } catch {
      throw new ConfigError(
        `cannot load pack "${name}"; add it to @harness/core-tools dependencies and run pnpm install`,
      );
    }
    if (!module.pack) throw new ConfigError(`module "${name}" exports no \`pack\``);
    all.push(module.pack);
  }
  return registryOf(all);
}
