import path from 'node:path';
import { ConfigError } from '@harness/shared';
import { targetFor, type ExtractionManifest } from './extraction.js';
import type { PackEvals } from './evals.js';
import type { PackToolDeps } from './kernel.js';
import type { Policy } from './policy.js';
import type { AttachmentKindSpec, RecordKindSpec } from './records.js';
import type { AnyToolDef } from './tool.js';

/**
 * What core loads when it loads an area of the product.
 *
 * A pack is content plus a declaration: what it stores, which documents exist, what to pull out
 * of them, which forms and skills ship with them, what the default policy for its actions is,
 * and — since Plan 5 — which tools it contributes and which kernel tools those replace. It
 * depends on this package and on `@harness/shared`, and on nothing else in the workspace: never
 * on `@harness/core-tools` and never on `@harness/db`, which is what lets core load it by name.
 */
export interface Pack {
  /** Short, stable, lowercase. `deps.packs.byName('healthcare')`. */
  name: string;
  version: string;
  /** What this pack stores. At least one. */
  records: RecordKindSpec[];
  /** What hangs off a record: a licence, a link. Omit for a pack that attaches nothing. */
  attachments?: AttachmentKindSpec[];
  /** What `documents_classify` may return and `documents_ingest` may be told. */
  documentKinds: readonly string[];
  /** Which document kinds feed which record kinds, and the prose the model reads. */
  extraction: ExtractionManifest;
  /** Absolute path to the directory holding `templates.json` and its PDFs. Omit for a pack with no forms. */
  formsDir?: string;
  /** Absolute path to the directory of `<skill>/SKILL.md` folders. */
  skillsDir: string;
  /** Action-class defaults this pack ships. A client's `policy.yaml` still wins. */
  policy: Partial<Policy>;
  /**
   * Kernel tool names this pack's own tools supersede. A name listed here is not published; the
   * pack's tool of that name takes its place. Two loaded packs may not replace the same name,
   * and a name that is not a kernel tool is a startup failure, not a silent no-op.
   */
  replaces?: readonly string[];
  /**
   * Tools this pack adds to the catalogue, built once per server from the live dependency bag.
   * A handler reaches a kernel handler through `deps.kernelTools` and the three non-tool kernel
   * operations through `deps.kernel`.
   */
  tools?: (deps: PackToolDeps) => AnyToolDef[];
  evals?: PackEvals;
}

const NAME = /^[a-z][a-z0-9-]*$/;

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
  // A pack that replaces a tool has to ship one.
  if (pack.replaces && pack.replaces.length > 0 && !pack.tools) {
    throw new ConfigError(`pack "${pack.name}" replaces ${pack.replaces.length} kernel tools but contributes none`);
  }
  return pack;
}
