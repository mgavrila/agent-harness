import type { AttachmentKindSpec, ExtractionManifest, Pack, RecordKindSpec } from '@harness/pack-api';

/**
 * The loaded packs, as the rest of core-tools sees them. It hangs off `ToolDeps.packs`, so a
 * handler reaches the active pack's manifest or forms directory the same way it reaches the
 * database: through its dependencies, never through an import.
 *
 * Several packs can be loaded at once and `documentKinds()` unions them, but the two
 * singular accessors — `manifest()`, `formsDir()` — answer for the **first** pack named in
 * `HARNESS_PACKS`. One extraction manifest and one templates directory is what the document
 * and forms pipelines take today; making them per-pack is a feature, not a refactor, and waits
 * for the second pack that actually needs it. `byName` is there for a tool that knows which
 * pack it belongs to.
 */
export interface PackRegistry {
  /** Every loaded pack, in the order `HARNESS_PACKS` named them. */
  readonly all: Pack[];
  /** Throws `ConfigError` when no loaded pack has that name. */
  byName(name: string): Pack;
  /** Every document kind any loaded pack declares, deduplicated, first-pack order first. */
  documentKinds(): string[];
  /** Every record kind any loaded pack declares, parsed, in load order. */
  recordKinds(): RecordKindSpec[];
  /** Every attachment kind any loaded pack declares, parsed, in load order. */
  attachmentKinds(): AttachmentKindSpec[];
  /** The first pack's extraction manifest. */
  manifest(): ExtractionManifest;
  /** The first pack's forms directory. `HARNESS_FORMS_DIR` overrides it in `app/server.ts`. */
  formsDir(): string;
  /** One skills directory per loaded pack, in order. */
  skillsDirs(): string[];
}
