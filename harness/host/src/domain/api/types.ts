import type { AddressInfo } from 'node:net';
import type { SchedulerStatus } from '../playbooks/scheduler.js';

/**
 * The run API's limits (spec 5.8, decision 19). Constants, not settings: every one of them is a
 * bound on what one request may cost this process, and a deployment that wanted a different one
 * would be a deployment that had found a use this API was not built for.
 */

/** One request body. Enforced while reading, so a caller cannot stream a gigabyte at the process. */
export const API_MAX_BODY_BYTES = 1_048_576;
/** One message. Longer than any human writes and shorter than a document, which belongs in `incoming/`. */
export const API_MAX_TEXT_CHARS = 10_000;
export const API_MAX_ATTACHMENTS = 10;
/** How many of a thread's **most recent** messages `GET /v1/threads/:id` returns, newest last. */
export const API_THREAD_MESSAGES = 200;
/**
 * How often an idle stream writes a comment line. A run can go minutes between events while a
 * model thinks, and an idle-timeout proxy in between would close the connection; a comment is two
 * bytes of nothing that keeps it open and that every Server-Sent Events client ignores.
 */
export const SSE_KEEPALIVE_MS = 15_000;

/** Loopback, as spec 5.8 says. Compose overrides it, for the reason `APPROVALS_HEALTH_BIND` is overridden. */
export const DEFAULT_HOST_BIND = '127.0.0.1';
export const DEFAULT_HOST_PORT = 8788;

export interface RunApiOptions {
  /** `HARNESS_HOST_TOKEN`. Never empty: with no token there is no API (decision 13). */
  token: string;
  bind?: string;
  port?: number;
  /** The scheduler, so `GET /v1/status` can report it. Absent in a test that starts none. */
  scheduler?: { status(): SchedulerStatus };
}

export interface RunApiServer {
  /** Resolves once the socket is bound; `address()` is null before that. */
  ready: Promise<void>;
  /** The bound address, so a caller can pass port 0 and discover what it got. */
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}
