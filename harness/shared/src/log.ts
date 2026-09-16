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

/**
 * A logger that prefixes every line with `scope`, e.g. `createLogger('effects')`.
 *
 * The three levels are one function: the line carries no severity marker, because the scope
 * and the message are what a reader greps for, and every line goes to the same stream anyway.
 * They stay three names on the interface so a call site still says what it means.
 */
export function createLogger(scope: string): Logger {
  const write = (message: string, err?: unknown): void => {
    console.error(err === undefined ? `${scope}: ${message}` : `${scope}: ${message}: ${describeError(err)}`);
  };
  return { info: write, warn: write, error: write };
}
