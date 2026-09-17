import type { AttachmentKindSpec, ExtractionManifest, ExtractionTarget, Pack, RecordKindSpec } from '@harness/pack-api';

/**
 * The pack, target and record kind one document's extraction resolves to.
 *
 * With one pack loaded this is always that pack's only target. With two, an exact claim on the
 * document's kind wins over either pack's catch-all, which is what lets each pack's documents
 * reach its own target in one process.
 */
export interface ResolvedTarget {
  pack: Pack;
  target: ExtractionTarget;
  recordKind: RecordKindSpec;
  /** The attachment kinds the owning pack declares. The model is offered exactly these. */
  attachmentKinds: AttachmentKindSpec[];
  /** The owning pack's `extraction.role`, the first line of the prompt. */
  role: string;
  /** The owning pack's example imperatives, quoted inside the kernel's injection-defence block. */
  injectionExamples: readonly string[];
}

/**
 * The loaded packs, as the rest of core-tools sees them. It hangs off `ToolDeps.packs`, so a
 * handler reaches the active pack's manifest or forms directory the same way it reaches the
 * database: through its dependencies, never through an import.
 *
 * Several packs can be loaded at once and the plural accessors union them.
 *
 * **The primary pack rule.** The first entry of `HARNESS_PACKS` is the deployment's primary
 * pack, and it is what answers every question that has only one answer: `manifest()` (the
 * classification role and version), `formsDir()` (the templates directory), and the extraction
 * target for a document nobody has classified. Three places, one rule, stated here so no caller
 * has to rediscover it. A deployment orders `HARNESS_PACKS` to say which area of the product it
 * is mainly for; a caller that means a different pack's document says so with
 * `documents_classify`, or by declaring the kind at ingest.
 *
 * One classification role and one templates directory is what the document and forms pipelines
 * take today; making those two per-pack is a feature, not a refactor, and waits for the pack
 * that actually needs it. Everything else is already per-pack: `targetFor` resolves a *declared*
 * document kind to whichever loaded pack claims it, whatever the load order, and `byName` is
 * there for a tool that knows which pack it belongs to.
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
  /**
   * The target a document of this kind feeds: an exact claim first, then any catch-all, and for
   * an unclassified document the primary pack's first target — see the rule above. Throws
   * `ToolError` naming the kind when a kind was given and no loaded pack claims it.
   */
  targetFor(documentKind: string | undefined): ResolvedTarget;
  /**
   * The target that writes records of this kind, for a document whose own kind is unknown but
   * whose destination record is named. Separate from `targetFor` on purpose: a record kind is not
   * a document kind, and feeding one to the other is how a document of one pack's kind used to
   * reach another pack's target. Throws `ToolError` when no loaded pack extracts into that
   * record kind.
   */
  targetForRecordKind(kind: string): ResolvedTarget;
  /** The primary pack's extraction manifest, for the classification role and version. */
  manifest(): ExtractionManifest;
  /** The primary pack's forms directory. `HARNESS_FORMS_DIR` overrides it in `app/server.ts`. */
  formsDir(): string;
  /** One skills directory per loaded pack, in order. */
  skillsDirs(): string[];
}
