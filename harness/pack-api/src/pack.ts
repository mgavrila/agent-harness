import path from 'node:path';
import { ConfigError } from '@harness/shared';
import type { ProviderManifest } from './manifest.js';
import type { Policy } from './policy.js';
import type { AnyToolDef } from './tool.js';

/**
 * What core loads when it loads an area of the product.
 *
 * A pack is content plus a declaration: which documents exist, what to pull out of them, which
 * forms and skills ship with them, and what the default policy for its actions is. It depends
 * on this package and on `@harness/shared`, and on nothing else in the workspace — never on
 * `@harness/core-tools`, which is what lets core load it by name instead of importing it.
 */
export interface Pack {
  /** Short, stable, lowercase. `deps.packs.byName('healthcare')`. */
  name: string;
  version: string;
  /** What `documents_classify` may return and `documents_ingest` may be told. */
  documentKinds: readonly string[];
  /** The fields and credentials the extractor asks a model for. */
  extraction: ProviderManifest;
  /** Absolute path to the directory holding `templates.json` and its PDFs. */
  formsDir: string;
  /** Absolute path to the directory of `<skill>/SKILL.md` folders. */
  skillsDir: string;
  /** Action-class defaults this pack ships. A client's `policy.yaml` still wins. */
  policy: Partial<Policy>;
  evals?: { casesFile?: string; injectionFile?: string };
  /**
   * Tools this pack adds to the catalogue. It receives core's dependency bag as `unknown`,
   * because a pack cannot see `ToolDeps`; a pack that needs a field casts it deliberately.
   * No pack ships tools today.
   */
  tools?: (deps: unknown) => AnyToolDef[];
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
  for (const [field, value] of [
    ['formsDir', pack.formsDir],
    ['skillsDir', pack.skillsDir],
  ] as const) {
    if (!path.isAbsolute(value)) {
      throw new ConfigError(`pack "${pack.name}" ${field} must be an absolute path, got "${value}"`);
    }
  }
  return pack;
}
