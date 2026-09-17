import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '@harness/shared';
import { parseExtractionManifest, targetFor, type ExtractionManifest } from './extraction.js';
import type { RawAttachmentKind, RawRecordKind } from './records.js';
import type { Pack } from './types.js';

export type { Pack } from './types.js';

const NAME = /^[a-z][a-z0-9-]*$/;

/** What a pack's `schema/<kind>.json` holds, and what `loadPackSchema` reads out of it. */
export interface PackSchema {
  /** The pack root: one level up from `src/`. Every path a pack declares is resolved from it. */
  root: string;
  /** The pack's own `package.json` version, so the two cannot drift. */
  version: string;
  records: RawRecordKind[];
  attachments: RawAttachmentKind[];
  extraction: ExtractionManifest;
}

/**
 * Read the declaration files every pack ships, given the pack's own `import.meta.url`.
 *
 * `definePack` refuses a relative `formsDir` or `skillsDir`, because it would resolve against
 * whatever directory the harness process happened to start in — so a pack has to resolve its own
 * root, and doing it here means no pack gets that wrong. `schemaFile` is relative to the module
 * that passes its `import.meta.url`, the way a `require` specifier in that file would be.
 *
 * A `require` rather than a JSON import: an import would need an import attribute and a resolver
 * flag, and this keeps both files loadable from tsx, vitest and a built bundle alike.
 */
export function loadPackSchema(moduleUrl: string, schemaFile: string): PackSchema {
  const requireJson = createRequire(moduleUrl);
  const raw = requireJson(schemaFile) as Pick<PackSchema, 'records' | 'attachments'> & {
    extraction: ExtractionManifest;
  };
  const { version } = requireJson('../package.json') as { version: string };
  return {
    root: path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..'),
    version,
    records: raw.records,
    attachments: raw.attachments,
    extraction: parseExtractionManifest(raw.extraction),
  };
}

/**
 * Every tool name and every result key in the harness is lowercase snake case — `documents_get`,
 * `providers_get`, `record_id`, `credentials` — so one pattern covers both halves of
 * `evals.readback`.
 */
const TOOL_OR_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Declare a pack. Identity at runtime, plus the checks that turn a typo into a startup failure
 * naming the pack rather than a `forms_list_templates` that quietly reports no templates.
 *
 * The paths must be absolute: a pack resolves them from `import.meta.url`, and a relative one
 * would resolve against whatever directory the harness process happened to start in.
 */
export function definePack(pack: Pack): Pack {
  if (!NAME.test(pack.name)) {
    throw new ConfigError(`pack name "${pack.name}" must be lowercase letters, digits and hyphens`);
  }
  if (pack.version.trim() === '') throw new ConfigError(`pack "${pack.name}" has no version`);
  if (pack.documentKinds.length === 0) throw new ConfigError(`pack "${pack.name}" declares no document kinds`);
  if (pack.records.length === 0) throw new ConfigError(`pack "${pack.name}" declares no record kinds`);
  for (const [field, value] of [
    ['formsDir', pack.formsDir],
    ['skillsDir', pack.skillsDir],
  ] as const) {
    if (value !== undefined && !path.isAbsolute(value)) {
      throw new ConfigError(`pack "${pack.name}" ${field} must be an absolute path, got "${value}"`);
    }
  }

  // `documentKinds` and `extraction.document_kinds` are two hands describing the same list: the
  // first is what `documents_classify` may return and `documents_ingest` may be told, the second
  // is what the extraction manifest was built to cover. A pack that lets them drift would
  // classify a document its own manifest never mentions, or advertise coverage its extraction
  // step cannot reach — so they must name the same kinds in the same order.
  if (
    pack.documentKinds.length !== pack.extraction.document_kinds.length ||
    pack.documentKinds.some((kind, i) => kind !== pack.extraction.document_kinds[i])
  ) {
    throw new ConfigError(
      `pack "${pack.name}" documentKinds [${pack.documentKinds.join(', ')}] does not match extraction.document_kinds [${pack.extraction.document_kinds.join(', ')}]`,
    );
  }

  // Every extraction target must name a record kind this pack declares, or an extraction would
  // resolve to a kind the kernel cannot store.
  const recordKinds = new Set(pack.records.map((r) => r.kind));
  for (const target of pack.extraction.targets) {
    if (!recordKinds.has(target.record_kind)) {
      throw new ConfigError(
        `pack "${pack.name}" extraction target "${target.schema_name}" names record kind "${target.record_kind}", which the pack does not declare`,
      );
    }
  }
  // Every document kind must reach a target, or the first document of that kind fails at
  // extraction time instead of at startup.
  for (const kind of pack.documentKinds) {
    if (!targetFor(pack.extraction, kind)) {
      throw new ConfigError(`pack "${pack.name}" document kind "${kind}" reaches no extraction target`);
    }
  }
  // Every member of `evals.readback` is looked up by exact string at run time: a tool the eval
  // runner calls, or a key it reads off a result. A stray space or an empty string there makes a
  // case fail as a model miss — the runner calls a tool that does not exist, or reads a key
  // nothing carries — rather than as the typo it is, and the number lands in a report.
  for (const [field, value] of Object.entries(pack.evals?.readback ?? {}) as [string, string | undefined][]) {
    if (value !== undefined && !TOOL_OR_KEY.test(value)) {
      throw new ConfigError(
        `pack "${pack.name}" evals.readback.${field} must be lowercase letters, digits and underscores, got "${value}"`,
      );
    }
  }
  // A pack that replaces a tool has to ship one.
  if (pack.replaces && pack.replaces.length > 0 && !pack.tools) {
    throw new ConfigError(`pack "${pack.name}" replaces ${pack.replaces.length} kernel tools but contributes none`);
  }
  return pack;
}
