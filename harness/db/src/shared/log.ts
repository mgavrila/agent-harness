/**
 * A logger for @harness/db only.
 *
 * This is a deliberate second copy of core-tools' `shared/log.ts`, and the duplication is the
 * point: @harness/db is the bottom of the dependency graph, so importing core-tools from here
 * would be a cycle. The module is ten lines and has one job. If a second package below
 * core-tools ever needs the shared helpers, that is the moment to revisit the `@harness/shared`
 * package the design declined — see ARCHITECTURE.md, "The three error types".
 *
 * Output goes to stderr, always. stdout belongs to whatever a CLI is actually printing.
 */
export interface Logger {
  info(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

/** A message, never a payload: an error's message but never its stack, and never a row. */
function line(scope: string, message: string, err: unknown): string {
  if (err === undefined) return `${scope}: ${message}`;
  return `${scope}: ${message}: ${err instanceof Error ? err.message : String(err)}`;
}

export function createLogger(scope: string): Logger {
  const write = (message: string, err: unknown): void => {
    // eslint-disable-next-line no-console -- this module is the one place console is allowed
    console.error(line(scope, message, err));
  };
  return {
    info: (message, err) => write(message, err),
    warn: (message, err) => write(message, err),
    error: (message, err) => write(message, err),
  };
}
