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
  /** How a case reads back what it stored. Defaults to the kernel's names. */
  readback?: EvalReadback;
}

/**
 * How one extraction case reads back what it stored.
 *
 * A pack that ships no tools uses the kernel's three — `documents_ingest`, `documents_extract`,
 * `records_get` — and needs none of this. A pack that renames them, as healthcare does, says so
 * here rather than making the eval runner guess: the tool the runner reads with, the key on the
 * extract result that carries the record id, and the key on the read result that carries the
 * attachment list.
 */
export interface EvalReadback {
  /** The tool that reads a stored record back, e.g. `records_get` or healthcare's `providers_get`. */
  tool: string;
  /**
   * The key the record id travels under, used twice: the runner reads it off the
   * `documents_extract` result, then passes it back as `tool`'s single argument under the same
   * name. `records_get` wants `record_id` and `providers_get` wants `provider_id`, and in both
   * cases the extract result spelled it the same way — said out loud here rather than relied on
   * silently.
   */
  recordIdKey: string;
  /** The key on the read result carrying the attachment list, e.g. `attachments`. */
  attachmentsKey: string;
}
