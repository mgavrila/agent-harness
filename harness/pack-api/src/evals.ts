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
}
