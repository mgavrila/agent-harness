import { ConfigError, createLogger } from '@harness/shared';
import type { Pack } from '@harness/pack-api';
import { parseAttachmentKindSpec, parseRecordKindSpec } from '../documents/manifest.js';
import type { PackRegistry } from './types.js';

const log = createLogger('packs');

/** Shared between `loadPacks` and `registryOf`, which both refuse an empty pack list the same way. */
const NO_PACKS_MESSAGE = 'HARNESS_PACKS names no pack; at least one is required';

/**
 * A registry over packs that are already in hand. `makeTestDeps` and the surface recorder use
 * it, and `loadPacks` below builds one over whatever it resolved.
 *
 * `recordKinds()` and `attachmentKinds()` answer with each pack's declarations **parsed**, not
 * the raw values off `Pack.records` and `Pack.attachments`. Those members are typed against the
 * contract, but a pack is free to hand in the raw JSON a human edits — `packs/healthcare/src/
 * index.ts` casts `provider.json` rather than validating it — and the raw value is missing the
 * zod defaults `buildExtractionSchema` depends on (`restricted: false`, `source: 'model'`).
 * Parsing here, once, at construction, is what makes those defaults exist no matter which pack,
 * or which test, built this registry; validating against *this build's* restricted-name rules
 * rather than the pack's matters too, because those rules decide what gets encrypted, so they
 * belong to whoever does the encrypting. A pack shipped against an older rule set fails here,
 * at startup, named.
 *
 * Refuses an empty list up front: `manifest()` and `formsDir()` would otherwise answer for
 * `all[0]` of an empty array, throwing a raw `TypeError` that names no variable and no pack.
 */
export function registryOf(all: Pack[]): PackRegistry {
  if (all.length === 0) throw new ConfigError(NO_PACKS_MESSAGE);
  // Parsed here, once, at construction: a pack hands over the JSON a human edits, and these are
  // the rules that decide what gets encrypted, so they are applied by whoever does the
  // encrypting. A pack shipped against an older rule set fails here, at startup, named.
  const records = all.flatMap((p) => p.records.map((r) => parseRecordKindSpec(r)));
  const attachments = all.flatMap((p) => (p.attachments ?? []).map((a) => parseAttachmentKindSpec(a)));
  return {
    all,
    byName(name) {
      const found = all.find((p) => p.name === name);
      if (!found) throw new ConfigError(`no pack named "${name}" is loaded`);
      return found;
    },
    documentKinds: () => [...new Set(all.flatMap((p) => [...p.documentKinds]))],
    recordKinds: () => records,
    attachmentKinds: () => attachments,
    manifest: () => all[0].extraction,
    formsDir: () => {
      const dir = all[0].formsDir;
      if (!dir) throw new ConfigError(`pack "${all[0].name}" ships no forms directory`);
      return dir;
    },
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
 * A dynamic `import()` can fail three different ways, and they are told apart so a pack's own
 * startup error is never swallowed by the generic "cannot load" message:
 *
 *  - the specifier does not resolve (`ERR_MODULE_NOT_FOUND`) or resolves to a package with no
 *    such subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — the resolver error's own message carries
 *    absolute filesystem paths and a node_modules layout that does not belong in a container
 *    log an operator pastes into a ticket, so it is replaced with a message naming only the
 *    module;
 *  - the module resolves and evaluates but throws a `ConfigError` while doing so — a pack
 *    validating its own config, e.g. `definePack` rejecting a relative `formsDir`. A
 *    `ConfigError`'s message is safe by construction (see `@harness/shared`'s `errors.ts`), so
 *    it is re-raised, prefixed with the pack's name;
 *  - anything else — logged in full through the shared logger, because it may carry a path or
 *    other detail that should reach an operator's log but not a thrown message, and replaced
 *    with a message naming only the pack.
 *
 * `registryOf` itself parses each pack's record and attachment kinds — see its comment — so a
 * malformed one fails here too, named, rather than silently reaching `documents_extract` with
 * its defaults missing.
 */
export async function loadPacks(names: string[]): Promise<PackRegistry> {
  if (names.length === 0) throw new ConfigError(NO_PACKS_MESSAGE);
  const all: Pack[] = [];
  for (const name of names) {
    let module: { pack?: Pack };
    try {
      module = (await import(name)) as { pack?: Pack };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw new ConfigError(
          `cannot load pack "${name}"; add it to @harness/core-tools dependencies and run pnpm install`,
        );
      }
      if (err instanceof ConfigError) {
        throw new ConfigError(`pack "${name}": ${err.message}`);
      }
      log.error(`pack "${name}" failed to initialise`, err);
      throw new ConfigError(`pack "${name}" failed to initialise`);
    }
    if (!module.pack) throw new ConfigError(`module "${name}" exports no \`pack\``);
    all.push(module.pack);
  }
  return registryOf(all);
}
