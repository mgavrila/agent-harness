import { ConfigError, ToolError, createLogger } from '@harness/shared';
import { ANY_DOCUMENT_KIND, type AttachmentKindSpec, type ExtractionTarget, type Pack } from '@harness/pack-api';
import { parseAttachmentKindSpec, parseRecordKindSpec } from '../documents/manifest.js';
import type { PackRegistry, ResolvedTarget } from './types.js';

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
  // Per pack as well as flattened: a resolved target offers the model exactly its own pack's
  // attachment kinds, and parsing them once here is what keeps `targetFor` free of zod.
  const attachmentsOf = new Map<string, AttachmentKindSpec[]>(
    all.map((p) => [p.name, (p.attachments ?? []).map((a) => parseAttachmentKindSpec(a))]),
  );
  const attachments = all.flatMap((p) => attachmentsOf.get(p.name) ?? []);

  // No two loaded packs may claim the same document kind, and `'*'` is a kind for this purpose.
  //
  // Without this, `targetFor` would be decided by HARNESS_PACKS order: two packs declaring a
  // catch-all both claim every document, and the second one silently never receives a
  // document at all — its extractions would be built against the first pack's record kind and
  // would fail deep in the pipeline with a missing-name error that names the wrong domain.
  // Refusing at construction turns a routing mystery into a startup message naming both packs.
  // Within one pack the same collision is already a `ConfigError` from `parseExtractionManifest`.
  const claimedBy = new Map<string, string>();
  for (const pack of all) {
    for (const target of pack.extraction.targets) {
      for (const kind of target.document_kinds) {
        const already = claimedBy.get(kind);
        if (already !== undefined && already !== pack.name) {
          throw new ConfigError(
            `packs "${already}" and "${pack.name}" both claim document kind "${kind}"; ` +
              'at most one loaded pack may claim a kind, and only one may declare the "*" catch-all',
          );
        }
        claimedBy.set(kind, pack.name);
      }
    }
  }

  // Two packs declaring one record kind name would make `records.kind` ambiguous: the unique
  // index on (client, kind, external_id) would fold two packs' records together, and
  // `packForKind` would stamp whichever pack loaded first.
  const declaredBy = new Map<string, string>();
  for (const pack of all) {
    for (const record of pack.records) {
      const already = declaredBy.get(record.kind);
      if (already !== undefined) {
        throw new ConfigError(
          `packs "${already}" and "${pack.name}" both declare record kind "${record.kind}"; ` +
            'a record kind name identifies one pack’s records and may not be shared',
        );
      }
      declaredBy.set(record.kind, pack.name);
    }
  }

  function resolve(pack: Pack, target: ExtractionTarget): ResolvedTarget {
    const recordKind = records.find((r) => r.kind === target.record_kind);
    // definePack already refused a target naming an undeclared kind, so this is unreachable
    // unless a pack was built against a different contract than the one that loaded it.
    if (!recordKind) {
      throw new ConfigError(`pack "${pack.name}" target names unknown record kind "${target.record_kind}"`);
    }
    return {
      pack,
      target,
      recordKind,
      attachmentKinds: attachmentsOf.get(pack.name) ?? [],
      role: pack.extraction.role,
    };
  }

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
    recordKind(kind) {
      const found = records.find((r) => r.kind === kind);
      if (!found) throw new ToolError(`no loaded pack declares record kind "${kind}"`);
      return found;
    },
    attachmentKind: (kind) => attachments.find((a) => a.kind === kind),
    targetFor(documentKind) {
      // An exact claim wins over any catch-all; only then does a catch-all answer. The result
      // does not depend on load order: the claim check above has already refused two packs
      // claiming one kind, so at most one exact claim and at most one catch-all exist.
      if (documentKind !== undefined) {
        for (const pack of all) {
          const exact = pack.extraction.targets.find((t) => t.document_kinds.includes(documentKind));
          if (exact) return resolve(pack, exact);
        }
      }
      for (const pack of all) {
        const any = pack.extraction.targets.find((t) => t.document_kinds.includes(ANY_DOCUMENT_KIND));
        if (any) return resolve(pack, any);
      }
      throw new ToolError(
        `no loaded pack extracts a document of kind "${documentKind ?? 'unknown'}"; classify it first`,
      );
    },
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
