import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashArgs, writeAudit } from '@harness/core-tools';
import type { Db } from '@harness/db';
import { ConfigError } from '@harness/shared';
import {
  SURFACE_HTTP_PATH_PATTERN,
  SURFACE_REFUSAL_REASON_PATTERN,
  type SurfaceHttp,
  type SurfaceHttpResponse,
  type SurfaceSession,
} from '@harness/surface-api';
import type { HostPool } from '../tenancy/types.js';
import { json, readBody } from './http.js';
import { API_MAX_BODY_BYTES, TENANT_PREFIX } from './types.js';

/**
 * Serving a surface that is reached by a request (spec section 4.6).
 *
 * Nothing here knows what a surface's transport is. A session offers a mount path and a handler;
 * this file resolves which tenant a request belongs to, hands the handler the method, the rest of
 * the path, the lower-cased headers and the raw body, and sends back what it answers. The path
 * and the refusal reason are data a surface supplied, which is why `harness/host/src` can carry
 * this and still name no vendor.
 */

/** A surface that claimed this request, and where its own path starts. */
interface Mounted {
  session: SurfaceSession;
  http: SurfaceHttp;
  subPath: string;
}

/**
 * Refuse a tenant whose surfaces cannot be mounted, at open rather than at the first request.
 *
 * Two failures, both of them somebody's configuration: a path that is not a mount path — a
 * leading slash, an upper-case letter, a `..` segment that would climb out of the tenant prefix
 * into `/v1/runs` — and two of one tenant's surfaces claiming the same one, where whichever
 * loaded first would quietly take the other's traffic.
 */
export function assertMounts(client: string, sessions: readonly SurfaceSession[]): void {
  const claimed = new Map<string, string>();
  for (const session of sessions) {
    const mount = session.http;
    if (!mount) continue;
    if (!SURFACE_HTTP_PATH_PATTERN.test(mount.path)) {
      throw new ConfigError(
        `client "${client}": surface "${session.name}" asks for the mount path "${mount.path}", which is not one: lowercase letters, digits, hyphens and underscores in slash-separated segments, with no leading or trailing slash`,
      );
    }
    const owner = claimed.get(mount.path);
    if (owner !== undefined) {
      throw new ConfigError(
        `client "${client}": surfaces "${owner}" and "${session.name}" both ask for the mount path "${mount.path}"`,
      );
    }
    claimed.set(mount.path, session.name);
  }
}

/** The first surface whose mount path is this path, or is a prefix of it. */
function mountFor(sessions: readonly SurfaceSession[], path: string): Mounted | null {
  for (const session of sessions) {
    const http = session.http;
    if (!http) continue;
    if (path === http.path) return { session, http, subPath: '' };
    if (path.startsWith(`${http.path}/`)) return { session, http, subPath: path.slice(http.path.length + 1) };
  }
  return null;
}

/**
 * Lower-cased, and a header sent twice is its first value.
 *
 * Node hands a repeated header back as an array; a transport that signs its requests sends its
 * signature once, and a handler that had to choose between two would be the wrong place for that
 * decision to live.
 */
function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return headers;
}

/**
 * One row, and only one, per refused request (invariant 15).
 *
 * The reason and the mount path, never the body: a refused request has not been authenticated, so
 * nothing in it is worth recording and everything in it might be somebody's. A reason that is not
 * a reason — a sentence, an empty string, a surface's bug — is recorded as `unspecified` rather
 * than dropped, because losing the row would hide the refusal behind the mistake.
 */
async function auditRefusal(
  db: Db,
  entry: { client: string; asked: string; caller: string; method: string; path: string; reason: string },
): Promise<void> {
  await writeAudit(db, {
    client: entry.client,
    caller: entry.caller,
    tool: 'surface_request',
    actionClass: 'read',
    // `asked` is the client id the request named, which on a dedicated host is not `client`. It is
    // hashed rather than written out for the reason every `args_hash` is — it is a caller's string
    // — and it is in here at all so that two refusals naming two different tenants can be told
    // apart by an operator who is counting them.
    argsHash: hashArgs({ asked: entry.asked, method: entry.method, path: entry.path }),
    decision: 'refused',
    error: SURFACE_REFUSAL_REASON_PATTERN.test(entry.reason) ? entry.reason : 'unspecified',
  });
}

function send(res: ServerResponse, response: SurfaceHttpResponse): void {
  // The surface's own headers win: it knows what it is answering. Plain text is the default
  // because an acknowledgement is usually empty and a body typed `application/json` that is not
  // JSON is worse than one typed as text.
  res.writeHead(response.status, { 'content-type': 'text/plain; charset=utf-8', ...(response.headers ?? {}) });
  res.end(response.body ?? '');
}

/**
 * Serve one request below `/tenants/`.
 *
 * `/tenants/<clientId>/<path>`: the client id is resolved through the pool's own resolver, so a
 * dedicated host refuses any other client's id and audits it (invariant 19) and a pooled host
 * opens whichever tenant the path names.
 *
 * **Every miss below this prefix answers the same thing**: `404 {"error":"no such route"}`,
 * whether the client does not exist, this host does not serve it, or it serves it and no surface
 * of it claims that path. This prefix is in front of the bearer by design, so a body that said
 * "no such client" would let anyone who can reach the port enumerate which tenants this process
 * holds — the property the run API keeps with a bearer in front of it, and which this path has to
 * keep with nothing in front of it. The distinction still exists where it is useful: a dedicated
 * host's refusal is a tenant boundary somebody tried to cross and is written to the audit log,
 * and a pooled host asked for a client nobody has writes nothing, because nobody was refused —
 * there is nobody there.
 */
export async function handleSurfaceRequest(
  pool: HostPool,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
): Promise<void> {
  const rest = route.slice(TENANT_PREFIX.length);
  const slash = rest.indexOf('/');
  const asked = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  if (asked === '' || path === '') return json(res, 404, { error: 'no such route' });
  const method = req.method ?? '';
  if (pool.resolver.resolve({ from: 'api', clientId: asked }) !== asked) {
    if (pool.dedicatedClient !== null) {
      await auditRefusal(pool.db, {
        client: pool.dedicatedClient,
        asked,
        caller: 'http:request',
        method,
        path,
        reason: 'foreign_client',
      });
      pool.log.warn(`a request named a client this host does not serve; refused`);
    }
    return json(res, 404, { error: 'no such route' });
  }
  const tenant = await pool.tenantFor(asked);
  if (!tenant) return json(res, 404, { error: 'no such route' });
  const mount = mountFor(tenant.host.surfaces.all, path);
  if (!mount) return json(res, 404, { error: 'no such route' });
  const body = await readBody(req);
  // Answered, then the socket torn up, for the reason `openRunRoute` gives: a caller told nothing
  // learns nothing, and a caller that keeps sending anyway is cut off rather than read for as
  // long as it likes.
  if (!body.ok) {
    return json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` }, () => req.destroy());
  }
  const response = await mount.http.handle({
    method,
    path: mount.subPath,
    headers: headersOf(req),
    // The bytes as they arrived, decoded as UTF-8 and not parsed: a surface that verifies a
    // signature computes it over exactly this.
    body: body.text,
  });
  if (response.refusal) {
    await auditRefusal(pool.db, {
      client: tenant.clientId,
      asked,
      caller: `${mount.session.name}:request`,
      method,
      path,
      reason: response.refusal.reason,
    });
    pool.log.warn(`tenant ${tenant.clientId}: surface "${mount.session.name}" refused a request`);
  }
  send(res, response);
}
