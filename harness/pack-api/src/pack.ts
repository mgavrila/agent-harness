import path from 'node:path';
import { ConfigError } from '@harness/shared';
import { targetFor } from './extraction.js';
import type { Pack } from './types.js';

export type { Pack } from './types.js';

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
