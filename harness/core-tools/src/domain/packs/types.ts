import type { AttachmentKindSpec, ExtractionManifest, ExtractionTarget, Pack, RecordKindSpec } from '@harness/pack-api';

/**
 * The pack, target and record kind one document's extraction resolves to.
 *
 * With one pack loaded this is always that pack's only target. With two, an exact claim on the
 * document's kind wins over either pack's catch-all, which is what lets a meeting note reach the
 * stories pack while a state licence reaches the healthcare pack in the same process.
 */
export interface ResolvedTarget {
  pack: Pack;
  target: ExtractionTarget;
  recordKind: RecordKindSpec;
  /** The attachment kinds the owning pack declares. The model is offered exactly these. */
  attachmentKinds: AttachmentKindSpec[];
  /** The owning pack's `extraction.role`, the first line of the prompt. */
  role: string;
}

/**
 * The loaded packs, as the rest of core-tools sees them. It hangs off `ToolDeps.packs`, so a
 * handler reaches the active pack's manifest or forms directory the same way it reaches the
 * database: through its dependencies, never through an import.
 *
 * Several packs can be loaded at once and `documentKinds()` unions them, but the two
 * singular accessors — `manifest()`, `formsDir()` — answer for the **first** pack named in
 * `HARNESS_PACKS`. One classification role and one templates directory is what the document
 * and forms pipelines take today; making them per-pack is a feature, not a refactor, and waits
 * for the second pack that actually needs it. Extraction is already per-pack: `targetFor`
 * resolves a document's kind to whichever loaded pack claims it. `byName` is there for a tool
 * that knows which pack it belongs to.
 */
export interface PackRegistry {
  /** Every loaded pack, in the order `HARNESS_PACKS` named them. */
  readonly all: Pack[];
  /** Throws `ConfigError` when no loaded pack has that name. */
  byName(name: string): Pack;
  /** Every document kind any loaded pack declares, deduplicated, first-pack order first. */
  documentKinds(): string[];
  /** Every record kind any loaded pack declares, parsed against this build's redaction rules. */
  recordKinds(): RecordKindSpec[];
  /** Every attachment kind any loaded pack declares, parsed, in load order. */
  attachmentKinds(): AttachmentKindSpec[];
  /** Throws `ToolError` when no loaded pack declares it. */
  recordKind(kind: string): RecordKindSpec;
  /** `undefined` when no loaded pack declares it; the caller decides whether that is an error. */
  attachmentKind(kind: string): AttachmentKindSpec | undefined;
  /** Throws `ToolError` when nothing claims the kind and no pack declares a catch-all. */
  targetFor(documentKind: string | undefined): ResolvedTarget;
  /** The first pack's extraction manifest, for the classification role and version. */
  manifest(): ExtractionManifest;
  /** The first pack's forms directory. `HARNESS_FORMS_DIR` overrides it in `app/server.ts`. */
  formsDir(): string;
  /** One skills directory per loaded pack, in order. */
  skillsDirs(): string[];
}
