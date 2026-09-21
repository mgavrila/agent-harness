import type { AddressInfo } from 'node:net';

/**
 * The run API's limits (spec 5.8, decision 19). Constants, not settings: the five below are what
 * one request may cost this process and how often an idle stream speaks, and a deployment that
 * wanted a different one would be a deployment that had found a use this API was not built for.
 * The bind and the port after them are the exception — those are defaults an operator overrides.
 */

/**
 * One request body. Enforced while reading: past the cap nothing further is read off the socket
 * and the connection is dropped once the refusal has been written, so a caller cannot stream a
 * gigabyte at the process by ignoring the answer.
 */
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

/**
 * Where the listener binds when the environment says nothing. Defaults rather than bounds: a
 * deployment sets `HARNESS_HOST_BIND` and `HARNESS_HOST_PORT` over them, and Compose does set the
 * bind, for the reason `APPROVALS_HEALTH_BIND` is overridden. Loopback, as spec 5.8 says.
 */
export const DEFAULT_HOST_BIND = '127.0.0.1';
export const DEFAULT_HOST_PORT = 8788;

/**
 * The header a caller names its client with.
 *
 * On a dedicated host it may be absent and a value that is not that host's client is refused; on
 * a pooled host it is required, because a pool that picked a tenant for a caller who had not
 * named one would pick the wrong one the day it had two.
 */
export const CLIENT_HEADER = 'x-harness-client';

/**
 * Where every tenant's surface mounts hang: `/tenants/<clientId>/<the surface's own path>`.
 *
 * One rule for a dedicated host and a pooled one alike (spec decision 4, which allows the tenant
 * to be resolved from a workspace key the surface carries, an HTTP header, or a path). A path, not
 * a header, because a path is the only one of the three a transport that knows nothing about this
 * deployment can be told to use — an app's request URL is configured once, in the app, and it
 * carries the tenant with it. Nothing below this prefix is behind the bearer: what protects it is
 * the surface's own verification of its own transport's signature.
 */
export const TENANT_PREFIX = '/tenants/';

export interface RunApiOptions {
  /**
   * `HARNESS_HOST_TOKEN`. **Empty closes `/v1/*`, it does not close the listener**: this server
   * also carries every tenant's surface mounts, which have their own protection and must answer
   * whether or not this deployment uses the run API. An empty token is refused explicitly rather
   * than compared, because two empty buffers compare equal and `Bearer ` would otherwise pass.
   */
  token: string;
  bind?: string;
  port?: number;
}

export interface RunApiServer {
  /** Resolves once the socket is bound; `address()` is null before that. */
  ready: Promise<void>;
  /** The bound address, so a caller can pass port 0 and discover what it got. */
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}
