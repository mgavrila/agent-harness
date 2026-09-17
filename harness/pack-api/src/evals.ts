/**
 * What `@harness/evals` needs from a pack in order to evaluate it without importing it.
 *
 * Before this existed the eval runner imported `@harness/pack-healthcare` in three files and
 * hard-coded its judged field list in a fourth. Every path below is absolute, resolved by the
 * pack from `import.meta.url`, for the same reason `skillsDir` is.
 */
export interface PackEvals {
  /** Extraction cases, one JSON object per line. */
  casesFile: string;
  /** Prompt-injection cases. Omit when the pack ships none. */
  injectionFile?: string;
  /** Where the case `path` values are resolved from, and the tools' storage directory. */
  corpusDir?: string;
  /** Absolute path to the `SKILL.md` whose frontmatter declares the tool set the injection check asserts against. */
  intakeSkill: string;
  /**
   * Free-text fields the LLM judge may score. A near miss on a practice name is a match; a near
   * miss on a date is a miss. **No restricted field may be listed**: its value never leaves the
   * database in plaintext, so there would be nothing to compare, and a judge prompt carrying one
   * would ship it to a third-party model. The dual-pack test asserts it for every loaded pack.
   */
  judgedFields: readonly string[];
  /** Module specifier exporting `generate(options)` for the synthetic corpus, e.g. `@harness/pack-stories/generate`. */
  generate?: string;
  /**
   * The environment this pack's tools must see under test, in place of the process's own.
   *
   * A pack reads its configuration from `deps.env`, so whoever builds the dependency bag decides
   * what it finds — and under test that has to be a fixed map, because the shipped `.env` on a
   * developer's machine turns outbound lookups on and points them at a live endpoint. Before this
   * member existed, the two builders of that map (`makeTestDeps` and `openPipeline`) hard-coded
   * one pack's variable names, which is a kernel and a runner knowing an area of the product.
   * Each pack names its own pins here instead, and both builders merge every loaded pack's.
   *
   * Only pins belong here: a switch turned off, an endpoint pointed at a port nothing listens on.
   * A test that wants the behaviour switched on overrides `env` with its own stub's URL.
   */
  testEnv?: Readonly<Record<string, string>>;
  /**
   * Which tools one eval case drives, and which keys their results carry. Every member defaults
   * to the kernel's own name, so a pack that ships no tools of its own may omit the block.
   */
  readback?: EvalReadback;
}

/**
 * Which tools one extraction case drives, and which keys their results carry.
 *
 * `@harness/evals` runs the same three steps for every pack — ingest the document, extract it,
 * read the record back — and before this block existed it named those steps' tools as string
 * literals. That is only correct for a deployment whose tools are the kernel's. A pack may
 * replace a kernel tool under the same name and answer in its own vocabulary, which healthcare
 * does: its `documents_extract` returns the new record's id under `provider_id`, not
 * `record_id`. A second pack measured beside it read a key that was never there, got
 * `undefined`, and failed every case — which is what this block exists to prevent.
 *
 * Every member is optional and defaults to the kernel's name, so a pack that ships no tools of
 * its own needs none of them. A pack that renames or replaces one says so here rather than
 * making the eval runner guess.
 */
export interface EvalReadback {
  /** Registers the document. Takes `{ path }`. Default `documents_ingest`. */
  ingestTool?: string;
  /**
   * Decides the document's kind. Default `documents_classify`.
   *
   * Declared for completeness — a pack describes its whole pipeline here, and a reader of the
   * pack should not have to know which of the three steps today's `runCase` happens to drive.
   * `runCase` does not call it: an eval case declares its own kind, and adding a call would
   * change what every existing run measures.
   */
  classifyTool?: string;
  /** Reads the document and writes the record. Takes `{ document_id }`. Default `documents_extract`. */
  extractTool?: string;
  /** Reads a stored record back, e.g. `records_get` or healthcare's `providers_get`. Default `records_get`. */
  readTool?: string;
  /**
   * The key the record id travels under: read off `extractTool`'s result, then passed back as
   * `readTool`'s single argument under the same name. `records_get` wants `record_id` and
   * `providers_get` wants `provider_id`. Default `record_id`.
   *
   * The two halves can come apart, and the eval runner resolves them separately: `replaces` is
   * process-wide, so the pack that publishes `documents_extract` in a given deployment need not
   * be the pack being measured. The runner takes the key it reads the extract result with from
   * whichever loaded pack publishes that tool, and the key it calls `readTool` with from the
   * measured pack. Both are this member, each read off its own pack.
   */
  recordIdKey?: string;
  /** The key on the read result carrying the attachment list, e.g. `attachments`. Default `attachments`. */
  attachmentsKey?: string;
}
