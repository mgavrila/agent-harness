/**
 * The only four error types this codebase raises deliberately. Everything else is a plain
 * `Error`, which the tooling kernel masks before it can reach an agent — see `runAuto`.
 *
 * The distinction is not stylistic. A raw error message can carry a provider's name, a row id
 * or a restricted identifier, so the kernel replaces it with "internal error; see audit log"
 * and keeps the real one in `audit_log.error`. A `ToolError` is the author saying "this
 * message is safe and the caller can act on it".
 */

/** An expected failure the caller can do something about. Its message reaches the agent. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * The model's output failed to parse as JSON, or parsed but did not match the caller's zod
 * schema. Gateway-side `strict: true` on the response schema is a request, not a guarantee
 * every provider honors, so this is checked again on this side. The message carries only the
 * zod issue paths and zod's own type-name wording, never a value from the reply, which may
 * contain document text — so, unlike most failures, it is safe to surface to the agent, which
 * needs the field detail to have any chance of recovering. A `ToolError` subclass for exactly
 * that reason: only a `ToolError`'s message reaches the caller.
 */
export class ModelOutputError extends ToolError {
  constructor(route: string, detail: string) {
    super(`model output invalid on route ${route}: ${detail}`);
    this.name = 'ModelOutputError';
  }
}

/**
 * The process is misconfigured and must not start. Raised only from this package's `env.ts`
 * and from an `app/` folder, never from a handler: by the time a tool runs, configuration is
 * settled.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The message of whatever was thrown, for a log line or an audit row. One definition, because
 * `err instanceof Error ? err.message : String(err)` was written out at 30-odd call sites and
 * two of them had already drifted into printing the whole error object.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A messaging surface could not do what was asked: a conversation id that is not that surface's
 * shape, a capability it does not have, or a transport that refused.
 *
 * Deliberately **not** a `ToolError`. It is raised below the tool layer, by an adapter, and it
 * never reaches an agent by itself — the host decides what to do with it, which is to record it
 * on the effect row or to say it in the thread. Both of those are plaintext, so the message
 * names the surface and the operation and never a path, a token or a payload value.
 */
export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceError';
  }
}
