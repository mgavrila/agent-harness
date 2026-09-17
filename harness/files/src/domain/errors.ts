/**
 * A failure the worker reports to its caller, with the HTTP status it maps to. The message is
 * what core-tools will put in front of an agent and in `audit_log.error`, so it names a file's
 * basename at most — never a path, never a line of the page.
 */
export class ParseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ParseError';
    this.status = status;
  }
}
