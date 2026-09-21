import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLIENT_ID_PATTERN } from '@harness/config-api';
import { hashArgs, writeAudit } from '@harness/core-tools';
import type { Db } from '@harness/db';
import { ConfigError, type Logger } from '@harness/shared';
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

/** True when `path` is `mount` itself or lies below it, counting whole segments only. */
function below(mount: string, path: string): boolean {
  return path === mount || path.startsWith(`${mount}/`);
}

/**
 * Refuse a tenant whose surfaces cannot be mounted, at open rather than at the first request.
 *
 * Two failures, both of them somebody's configuration: a path that is not a mount path — a
 * leading slash, an upper-case letter, a `..` segment that would climb out of the tenant prefix
 * into `/v1/runs` — and two of one tenant's surfaces whose paths overlap, where whichever loaded
 * first would quietly take the other's traffic.
 *
 * Overlapping is wider than identical, because `mountFor` takes the first surface the path is
 * below: `messages` and `messages/inbound` are two distinct paths that both pass a duplicate
 * check, and a request to the longer one would go to whichever surface the document happened to
 * declare first, with `inbound` as its sub-path. Segments, not characters — `messagesfoo` is not
 * below `messages` and neither can take the other's traffic, so a pair like that is left alone.
 */
export function assertMounts(client: string, sessions: readonly SurfaceSession[]): void {
  const claimed: { path: string; name: string }[] = [];
  for (const session of sessions) {
    const mount = session.http;
    if (!mount) continue;
    if (!SURFACE_HTTP_PATH_PATTERN.test(mount.path)) {
      throw new ConfigError(
        `client "${client}": surface "${session.name}" asks for the mount path "${mount.path}", which is not one: lowercase letters, digits, hyphens and underscores in slash-separated segments, with no leading or trailing slash`,
      );
    }
    // Either direction: the pair is unreachable whichever of the two was declared first, and
    // saying which is longer is more use to whoever has to fix it than saying which came first.
    const clash = claimed.find((other) => below(other.path, mount.path) || below(mount.path, other.path));
    if (clash) {
      throw new ConfigError(
        `client "${client}": surfaces "${clash.name}" and "${session.name}" ask for the mount paths "${clash.path}" and "${mount.path}", and one is below the other, so only the first would ever be reached`,
      );
    }
    claimed.push({ path: mount.path, name: session.name });
  }
}

/** The first surface whose mount path is this path, or is a whole-segment prefix of it. */
function mountFor(sessions: readonly SurfaceSession[], path: string): Mounted | null {
  for (const session of sessions) {
    const http = session.http;
    if (!http) continue;
    if (!below(http.path, path)) continue;
    return { session, http, subPath: path === http.path ? '' : path.slice(http.path.length + 1) };
  }
  return null;
}

/**
 * Lower-cased names, and each value exactly as the parser presents it.
 *
 * A header sent twice is **not** reduced to its first value, because the parser has already
 * folded the two by the time this runs: every name but `set-cookie` arrives as one string with
 * the values joined — `", "` for most of them, `"; "` for `cookie` — and the first value is no
 * longer recoverable from `headers` at all. Passing the join through is the only honest option,
 * and it is the safe one: a signature computed over one value does not match the join, so a
 * transport that verifies its requests refuses a duplicated header rather than accepting an
 * injected second one. `SurfaceHttpRequest.headers` says this, so an adapter can rely on it.
 *
 * `set-cookie` is the parser's one exception and arrives as an array. It has no meaning on an
 * inbound request; it is joined the way the others already are rather than being dropped,
 * because a seam typed `Record<string, string>` has nowhere to put a list.
 */
function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
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

/**
 * The one answer every miss below this prefix gets, whatever the miss was.
 *
 * Named rather than repeated, because the uniformity is the point: the four ways a request can
 * fail to reach a surface — a shape that is not a client id, a client this host does not serve, a
 * client nobody has, a path no surface claims — are told apart by the audit log and by nothing a
 * caller can see. See `handleSurfaceRequest`.
 */
function noRoute(res: ServerResponse): void {
  json(res, 404, { error: 'no such route' });
}

/**
 * Wait for the socket to drain, or for the caller to go away — whichever comes first.
 *
 * `res.write` answers false when the kernel buffer is full, and a producer that ignored that
 * would hold the whole response in this process's memory for a client reading it slowly. Waiting
 * on `drain` alone is the trap on the other side: a client that disappears mid-write never
 * drains, and the generator would be parked forever. So both events settle it — and `close` is
 * also what aborts the request's signal, so the producer is already on its way out.
 */
async function drained(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * Send what the surface answered: a whole body, or a stream of chunks as they are produced.
 *
 * The head is written once, from the surface's own status and headers, and after that this
 * function copies bytes it does not read. A chunk is whatever the adapter yielded — a
 * Server-Sent Events frame, a line of NDJSON, a fragment of anything — which is what keeps a
 * transport's framing inside the adapter and out of this file.
 *
 * A throw out of the iterable ends the response with what has already been written. There is no
 * error frame and no status change: the status went out with the head, and inventing a frame here
 * would mean this file knew what the adapter's frames look like.
 */
async function send(res: ServerResponse, response: SurfaceHttpResponse, log: Logger, what: string): Promise<void> {
  // The surface's own headers win: it knows what it is answering. Plain text is the default
  // because an acknowledgement is usually empty and a body typed `application/json` that is not
  // JSON is worse than one typed as text.
  res.writeHead(response.status, { 'content-type': 'text/plain; charset=utf-8', ...(response.headers ?? {}) });
  const body = response.body;
  if (body === undefined || typeof body === 'string') {
    res.end(body ?? '');
    return;
  }
  // The head goes out now rather than with the first chunk. Node buffers it until something is
  // written, and a client that waits for the headers before it reads — which every reader of an
  // event stream does — would be waiting on a frame the producer has not made yet, while the
  // producer waits for nothing at all. Only the streaming branch needs it: a whole body writes
  // the head and the bytes in the same breath.
  res.flushHeaders();
  try {
    for await (const chunk of body) {
      if (res.writableEnded || res.destroyed) break;
      if (!res.write(chunk)) await drained(res);
    }
  } catch (err) {
    log.error(`${what} failed mid-stream`, err);
  } finally {
    if (!res.writableEnded) res.end();
  }
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
 * of it claims that path. This prefix is in front of the bearer, so a body that said "no such
 * client" would tell an unauthenticated caller which kind of miss it had hit, and the kind is the
 * useful part: it is the difference between a wrong id and a right id at a wrong path. Only one
 * of these misses is written down anywhere: a dedicated host asked for a client it does not serve,
 * which is a tenant boundary somebody tried to cross and is audited as such (invariant 19). A
 * malformed id, a client nobody has and a path no surface claims all write nothing, because
 * nobody was refused — there is nobody there.
 *
 * **What this does not hide, stated plainly: that a tenant exists.** Every surface's mount path
 * is a public constant, so a caller who knows one and guesses the id gets an answer from the
 * surface rather than the 404 an unmounted path gets — a `GET` is 405, an unsigned `POST` is
 * whatever the adapter refuses with, a body over the cap is 413. Uniformity buys the kind of the
 * miss; it does not buy tenant secrecy, and nothing below this line is trying to. Nor is the cost
 * of a probe bounded here: an unsigned `POST` is one `audit_log` insert, a pooled miss for a
 * client that exists but is not open costs a config-source load, three plug-in loads, a playbook
 * sync and a scheduler start against one source lookup for a client nobody has, and that open
 * happens before anything has authenticated the caller. A rate limit and an ingress in front of
 * this port are the answer to all three, and they are the platform's (P2), not this function's.
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
  // Before the resolver and before the pool, because neither is the place to bound a caller's
  // string. A config source is entitled to throw on something that is not an id — the files one
  // does — and a rejection from there would reach the listener's catch, answer 500 where every
  // other miss answers 404, and write the caller's own string into this deployment's error log,
  // on a route with no bearer in front of it. The shape is `@harness/config-api`'s own, so what
  // is accepted here and what a document may call itself cannot drift apart.
  if (asked === '' || path === '' || !CLIENT_ID_PATTERN.test(asked)) {
    return noRoute(res);
  }
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
    return noRoute(res);
  }
  const tenant = await pool.tenantFor(asked);
  if (!tenant) return noRoute(res);
  const mount = mountFor(tenant.host.surfaces.all, path);
  if (!mount) return noRoute(res);
  const body = await readBody(req);
  // Answered, then the socket torn up, for the reason `openRunRoute` gives: a caller told nothing
  // learns nothing, and a caller that keeps sending anyway is cut off rather than read for as
  // long as it likes.
  if (!body.ok) {
    return json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` }, () => req.destroy());
  }
  // The caller going away is the one thing a streaming handler has to be able to hear, and the
  // response's own `close` is where the host hears it. It fires for an ordinary answer too, after
  // that answer has been sent, which costs a handler that has already returned nothing.
  const hungUp = new AbortController();
  res.on('close', () => hungUp.abort());
  let response: SurfaceHttpResponse;
  try {
    response = await mount.http.handle({
      method,
      path: mount.subPath,
      headers: headersOf(req),
      // The bytes as they arrived, decoded as UTF-8 and not parsed: a surface that verifies a
      // signature computes it over exactly this.
      body: body.text,
      // The tenant this request resolved to, a few lines above. An adapter that reports which
      // workspace an event came from reports this one, and cannot disagree with the route the
      // request actually took.
      clientId: tenant.clientId,
      signal: hungUp.signal,
    });
  } catch (err) {
    // A handler that threw refused nobody, so nothing is audited: invariant 15 is about a door
    // that turned a request away, and a row saying `refused` for a door that broke would tell an
    // operator counting tenant boundaries the wrong thing. One line, naming the tenant and the
    // mount and nothing a caller sent; the error itself goes beside it, where `startRunApi`'s own
    // catch puts one, because it is the surface's sentence rather than the request's.
    pool.log.error(
      `tenant ${tenant.clientId}: surface "${mount.session.name}" failed a request at "${mount.http.path}"`,
      err,
    );
    return json(res, 500, { error: 'surface failure' });
  }
  if (response.refusal) {
    // Before the head, and that is the whole of invariant 20's ordering: once `send` has written
    // a status there is no refusal left to declare, whether the body is a string or a stream.
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
  await send(
    res,
    response,
    pool.log,
    `tenant ${tenant.clientId}: surface "${mount.session.name}" at "${mount.http.path}"`,
  );
}
