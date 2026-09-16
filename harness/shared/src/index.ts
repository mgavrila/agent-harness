/**
 * The public API of @harness/shared.
 *
 * Seven modules of pure helpers with no domain knowledge and no workspace dependency, so the
 * packages at the bottom of the graph — @harness/db and every pack — can import them. Nothing
 * that knows what a provider, a document or an approval is belongs here; that lives in a
 * domain folder in the package that owns the concept. Redaction is the named exception and
 * stays in @harness/core-tools, because deciding which field names are restricted and which
 * SSN allocations are real is domain knowledge.
 */
export { ConfigError, ModelOutputError, ToolError, describeError } from './errors.js';
export {
  booleanFromEnv,
  numberFromEnv,
  optionalEnv,
  requiredEnv,
  type EnvSource,
  type NumberEnvOptions,
} from './env.js';
export { assertInsideRoot, realOrNearestAncestor, type EscapeReason, type InsideRootOptions } from './paths.js';
export { createLogger, type Logger } from './log.js';
export { runBounded, type RunBoundedOptions, type RunBoundedOutcome } from './subprocess.js';
export { readJsonl, writeJsonl, type JsonlRow } from './jsonl.js';
export { csvCell } from './csv.js';
