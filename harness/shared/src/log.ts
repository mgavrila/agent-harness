import { describeError } from './errors.js';

/**
 * The one place `console` is allowed outside a process entrypoint.
 *
 * Two rules the call sites depend on. First, everything goes to **stderr**: `@harness/core-tools`
 * runs as an MCP server over stdio, so anything on stdout corrupts the protocol frame. Second, a
 * log line carries a message and at most an error's message — never a payload, never a row,
 * never a stack. A restricted identifier that reaches a log has escaped every other guard.
 */
export interface Logger {
  info(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

function line(scope: string, message: string, err: unknown): string {
  return err === undefined ? `${scope}: ${message}` : `${scope}: ${message}: ${describeError(err)}`;
}

/** A logger that prefixes every line with `scope`, e.g. `createLogger('effects')`. */
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
