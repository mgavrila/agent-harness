import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import * as z from 'zod/v4';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import { RUN_FAILED_MESSAGE } from '@harness/runtime-api';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN, assertInsideRoot } from '@harness/shared';
import { cancelRun, runTurn, serialize, type TurnEvent } from '../conversation.js';
import type { Host } from '../host.js';
import type { SchedulerStatus } from '../playbooks/scheduler.js';
import type { HostPool } from '../tenancy/types.js';
import { WITHHELD, findOrCreateThread } from '../threads/repository.js';
import { json, readBody } from './http.js';
import {
  APPROVAL_STATUSES,
  MEMORY_SCOPES,
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  decodeCursor,
  readApprovals,
  readMemory,
} from './reads.js';
import { findRunFor, readThreadFor } from './repository.js';
import { handleSurfaceRequest } from './surfaces.js';
import { sseStream } from './sse.js';
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, endOfUtcDay, readUsage, startOfUtcDay } from './usage.js';
import {
  API_MAX_ATTACHMENTS,
  API_MAX_BODY_BYTES,
  API_MAX_TEXT_CHARS,
  CLIENT_HEADER,
  TENANT_PREFIX,
  type RunApiOptions,
} from './types.js';

/** A uuid, checked before it reaches Postgres: an id of any other shape is "no such thing", not an error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One day, for the usage window's default and its bound. */
const DAY_MS = 24 * 60 * 60 * 1000;

const OpenRunShape = z
  .object({
    surface: z.string().regex(SURFACE_NAME_PATTERN, 'a surface name is lowercase letters, digits and hyphens'),
    conversation: z
      .string()
      .regex(CONVERSATION_ID_PATTERN, 'a conversation id carries no spaces or control characters'),
    userId: z.string().min(1).max(200),
    text: z.string().min(1).max(API_MAX_TEXT_CHARS),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(255), path: z.string().min(1).max(512) }).strict())
      .max(API_MAX_ATTACHMENTS)
      .default([]),
  })
  .strict();

/**
 * Constant-time on the bytes, after a length check.
 *
 * `timingSafeEqual` throws on a length mismatch, and comparing lengths first leaks only the
 * token's length, which a caller who can measure a comparison could learn anyway.
 */
export function bearerOk(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const offered = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

type Caller = { ok: true; principal: Principal } | { ok: false; status: number; error: string };

/**
 * Who is asking, resolved exactly as it would be for an adapter's message (spec 5.8, invariant 1).
 *
 * The bearer secret says the *caller* may use this API; it does not say who they are acting as.
 * That is the identity plug-in's answer, from a surface and that surface's own user id, so nothing
 * a caller sends can name a principal directly.
 */
async function callerOf(host: Host, ref: { surface: string; userId: string }): Promise<Caller> {
  if (!SURFACE_NAME_PATTERN.test(ref.surface) || ref.userId === '') {
    return { ok: false, status: 400, error: 'surface and userId are required' };
  }
  if (!host.surfaces.find(ref.surface)) {
    return { ok: false, status: 400, error: `surface "${ref.surface}" is not loaded` };
  }
  const principal = await host.identity.resolve(ref);
  if (!principal) {
    return { ok: false, status: 403, error: 'that surface user is not a principal of this deployment' };
  }
  return { ok: true, principal };
}

/**
 * The same caller, named in the query string, for the two routes that address one thing by id.
 *
 * A missing parameter becomes the empty string rather than a special case: `callerOf` already
 * refuses both an empty user id and a surface name that is not one, with the message it would
 * give a request body that left them out.
 */
async function callerFromQuery(host: Host, url: URL): Promise<Caller> {
  return callerOf(host, {
    surface: url.searchParams.get('surface') ?? '',
    userId: url.searchParams.get('userId') ?? '',
  });
}

/**
 * Open a run and stream it (spec 5.8).
 *
 * `deliver: 'none'` (decision 14): the reply is recorded on the thread and posted nowhere, because
 * the caller is the one waiting for it and putting the same answer into the named surface's
 * conversation would be a message nobody there asked for. The stream is the reply.
 *
 * Every text-carrying frame goes through the restricted-pattern check on its way out (invariant
 * 10). A delta is checked on its own, so a pattern split across two deltas is caught only by the
 * closing `result` frame, which carries the whole reply already withheld — the same guarantee a
 * streamed surface reply has today.
 */
async function openRunRoute(host: Host, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  // The caller went away before the body ended. There is nothing to answer it with and nobody to
  // answer: writing a status into a dead socket would be a refusal nobody was given.
  if (body.kind === 'gone') return;
  // The 413 goes out first and the socket is torn up after it, so the caller is told why and a
  // caller that keeps sending anyway is cut off rather than read and discarded for as long as it
  // likes. Destroying before the flush would answer nothing; not destroying at all would let one
  // authenticated connection stream gigabytes past a cap that had already refused it.
  if (body.kind === 'too_large') {
    return json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` }, () => req.destroy());
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return json(res, 400, { error: 'the request body is not JSON' });
  }
  const parsed = OpenRunShape.safeParse(raw);
  if (!parsed.success) return json(res, 400, { error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  const caller = await callerOf(host, { surface: input.surface, userId: input.userId });
  if (!caller.ok) return json(res, caller.status, { error: caller.error });

  // An attachment is a path under the storage root, not bytes: the same contract an adapter's
  // `MessageEvent` carries. Checked before a run opens, so nothing is audited against a path that
  // was never acceptable.
  const incoming = path.join(host.config.storageDir, 'incoming');
  for (const attachment of input.attachments) {
    try {
      await assertInsideRoot(
        attachment.path,
        incoming,
        () => {
          throw new Error('outside');
        },
        { allowRoot: false },
      );
    } catch {
      return json(res, 400, { error: `attachment "${attachment.name}" is not a path inside the incoming directory` });
    }
  }

  const thread = await findOrCreateThread(host.db, {
    client: host.client,
    surface: input.surface,
    conversation: input.conversation,
    principalId: caller.principal.id,
  });

  const stream = sseStream(res);
  const safe = (text: string): string => (containsRestrictedPattern(text) ? WITHHELD : text);
  const observe = (event: TurnEvent): void => {
    if (event.type === 'text') stream.send('text', { type: 'text', delta: safe(event.delta) });
    else if (event.type === 'done') stream.send('done', { type: 'done', text: safe(event.text) });
    else stream.send(event.type, event);
  };

  try {
    // The same chain an adapter's message takes, so two requests on one conversation run one after
    // the other rather than over each other (decision 19).
    const result = await serialize(host, thread.id, () =>
      runTurn(host, {
        thread,
        principal: caller.principal,
        role: 'user',
        text: input.text,
        attachments: input.attachments,
        replyTo: null,
        deliver: 'none',
        observe,
      }),
    );
    if (result === undefined) {
      stream.send('error', { type: 'error', message: 'the host is shutting down; the run was not started' });
    }
  } catch (err) {
    host.log.error(`the run API failed a turn on thread ${thread.id}`, err);
    // The same sentence a runtime puts on its own `error` event: a caller streaming from this
    // API reads one wording for a broken run, whether the loop or the turn around it broke.
    stream.send('error', { type: 'error', message: RUN_FAILED_MESSAGE });
  } finally {
    stream.end();
  }
}

/** Cancel a run of the caller's own (spec 5.8). Another principal's run is "no such run" (decision 18). */
async function cancelRoute(host: Host, url: URL, res: ServerResponse, runId: string): Promise<void> {
  const caller = await callerFromQuery(host, url);
  if (!caller.ok) return json(res, caller.status, { error: caller.error });
  if (!UUID.test(runId)) return json(res, 404, { error: 'no such run' });
  const run = await findRunFor(host.db, { client: host.client, principalId: caller.principal.id, runId });
  if (!run) return json(res, 404, { error: 'no such run' });
  // False when the run has already ended or was already aborted — by the host's own timeout, say.
  // That is an answer, not an error: the caller asked for it to stop and it is stopped.
  return json(res, 200, { run_id: runId, cancelled: cancelRun(host, runId) });
}

/** A thread of the caller's own, most recent messages, newest last (spec 5.8). */
async function threadRoute(host: Host, url: URL, res: ServerResponse, threadId: string): Promise<void> {
  const caller = await callerFromQuery(host, url);
  if (!caller.ok) return json(res, caller.status, { error: caller.error });
  if (!UUID.test(threadId)) return json(res, 404, { error: 'no such thread' });
  const found = await readThreadFor(host.db, {
    client: host.client,
    principalId: caller.principal.id,
    threadId,
  });
  if (!found) return json(res, 404, { error: 'no such thread' });
  return json(res, 200, found);
}

/**
 * What one tenant is doing (decision 16): the surfaces it loaded, the runs in flight, and its
 * scheduler's own status, which had nowhere to be reported until this route existed.
 *
 * The scheduler is an argument rather than an option of the listener: a pooled host has one per
 * open tenant and no single one to have put in the options a listener was started with.
 *
 * Counts and names only, never a conversation, a principal or a message — the same rule `/healthz`
 * follows, and for the same reason.
 */
function statusRoute(host: Host, res: ServerResponse, scheduler: { status(): SchedulerStatus }): void {
  json(res, 200, {
    client: host.client,
    surfaces: host.surfaces.all.map((session) => session.name),
    primary_surface: host.surfaces.primary.name,
    runs_in_flight: host.active.size,
    draining: host.draining,
    scheduler: scheduler.status(),
  });
}

/**
 * What this tenant used, per principal per day (spec section 4.5, decision 15).
 *
 * `from` and `to` are ISO dates or timestamps, the window is half-open, and a request that names
 * neither gets the last thirty days. Bearer-authenticated and tenant-scoped like every other
 * route, and there is no way to widen it: the client is the one the request resolved to, never
 * one the caller asked for.
 *
 * The window is read as whole UTC days, because a row's `day` is one: `from` rounds down and `to`
 * rounds up, so a bound inside a day keeps that day rather than dropping it. Both directions
 * matter — a `from` of noon would drop that morning's usage, and a `to` of `now`, which is what a
 * request naming no window gets, would drop today altogether. A `to` that is already a midnight is
 * left where it is, so a caller who named a day boundary still gets the half-open window they
 * asked for. The bounds are checked after rounding and the answer reports the window it read.
 *
 * Counts, tokens, cost and seconds, and nothing anybody wrote — the view is what guarantees that
 * (invariant 16), and `usage.test.ts` asserts its column list whole.
 */
async function usageRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const askedFrom = url.searchParams.get('from');
  const askedTo = url.searchParams.get('to');
  const to = askedTo === null ? new Date() : new Date(askedTo);
  const from = askedFrom === null ? new Date(to.getTime() - USAGE_DEFAULT_DAYS * DAY_MS) : new Date(askedFrom);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return json(res, 400, { error: 'from and to are ISO timestamps' });
  }
  const days = { from: startOfUtcDay(from), to: endOfUtcDay(to) };
  if (days.to <= days.from) return json(res, 400, { error: 'to must be after from' });
  if (days.to.getTime() - days.from.getTime() > USAGE_MAX_DAYS * DAY_MS) {
    return json(res, 400, { error: `the window may not exceed ${USAGE_MAX_DAYS} days` });
  }
  return json(res, 200, {
    client: host.client,
    from: days.from.toISOString(),
    to: days.to.toISOString(),
    rows: await readUsage(host.db, { client: host.client, ...days }),
  });
}

/**
 * One page of this tenant's approvals (spec section 4.12).
 *
 * `status` is the column's own vocabulary and nothing else — `pending`, `approved`, `declined`,
 * `expired`, comma-separated for several — so a dashboard can render what it filtered on. An
 * unknown value is a 400 naming the four rather than an empty page, which is the failure a
 * caller cannot tell from "there are none".
 */
async function approvalsRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const limit = readLimit(url);
  if (limit === null) return json(res, 400, { error: `limit is a whole number between 1 and ${READ_MAX_LIMIT}` });
  const asked = url.searchParams.get('status');
  const statuses = asked === null ? [] : asked.split(',').map((value) => value.trim());
  const unknown = statuses.find((value) => !(APPROVAL_STATUSES as readonly string[]).includes(value));
  if (unknown !== undefined) {
    return json(res, 400, { error: `status is one of ${APPROVAL_STATUSES.join(', ')}, comma-separated for several` });
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && decodeCursor(cursor) === null) return json(res, 400, { error: 'cursor is not one of ours' });
  const page = await readApprovals(host.db, { client: host.client, statuses, cursor, limit });
  return json(res, 200, { client: host.client, ...page });
}

/** One page of this tenant's memory entries (spec section 4.12), oldest first. */
async function memoryRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const limit = readLimit(url);
  if (limit === null) return json(res, 400, { error: `limit is a whole number between 1 and ${READ_MAX_LIMIT}` });
  const scope = url.searchParams.get('scope');
  if (scope !== null && !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
    return json(res, 400, { error: `scope is one of ${MEMORY_SCOPES.join(', ')}` });
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && decodeCursor(cursor) === null) return json(res, 400, { error: 'cursor is not one of ours' });
  const principal = url.searchParams.get('principal');
  const page = await readMemory(host.db, {
    client: host.client,
    ...(scope === null ? {} : { scope }),
    ...(principal === null ? {} : { principal }),
    cursor,
    limit,
  });
  return json(res, 200, { client: host.client, ...page });
}

/**
 * The page size, or null for one this API will not serve.
 *
 * A limit is refused rather than clamped: a caller handed a silently smaller page believes they
 * have the whole of it, and the one thing a paged export must not do is look complete.
 */
function readLimit(url: URL): number | null {
  const raw = url.searchParams.get('limit');
  if (raw === null) return READ_DEFAULT_LIMIT;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= READ_MAX_LIMIT ? limit : null;
}

/**
 * Route one request: the run API below `/v1`, and every tenant's surface mounts below `/tenants`.
 *
 * Every `/v1` route is behind the bearer check, and then behind the tenant check. `/tenants` is
 * in front of both, for the reason in the body, and resolves its tenant from the path.
 *
 * `x-harness-client` names the client on the run API. On a dedicated host it may be absent, and a
 * value that is not that host's client is refused; on a pooled host it is required, because a
 * pool that picked a tenant for a caller who did not name one would pick the wrong one the day it
 * had two. A refusal is 404 with the same body a nonexistent route gets, so the API never
 * confirms that a client somebody guessed at exists — and `handleSurfaceRequest` keeps the same
 * property below `/tenants`, where there is no bearer in front of it to keep it.
 */
export async function handleApiRequest(
  pool: HostPool,
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunApiOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://run-api.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  // In front of the bearer, and deliberately: a tenant's surface is reached by a transport that
  // knows nothing about this deployment's secrets and everything about its own signature, so the
  // check that matters happens inside the surface. Spec section 4.6.
  //
  // The bare prefix is matched as well as everything below it, because the normalisation above
  // strips the trailing slash: `/tenants/` and `/tenants` are both the string `/tenants` by the
  // time this runs, and falling through would answer 401 for a request that names no tenant at
  // all rather than the 404 it deserves. `handleSurfaceRequest` answers that case already — the
  // slice is empty, so there is no client id.
  if (route === '/tenants' || route.startsWith(TENANT_PREFIX)) return handleSurfaceRequest(pool, req, res, route);
  // An empty configured token is refused before it is compared: `timingSafeEqual` on two empty
  // buffers is true, so `Bearer ` would otherwise authenticate a deployment that set no secret.
  if (opts.token === '' || !bearerOk(req.headers.authorization, opts.token)) {
    return json(res, 401, { error: 'unauthorised' });
  }
  const named = req.headers[CLIENT_HEADER];
  const clientId = typeof named === 'string' && named.trim() !== '' ? named.trim() : null;
  const resolved = pool.resolver.resolve({ from: 'api', clientId });
  const tenant = resolved === null ? null : await pool.tenantFor(resolved);
  if (!tenant) return json(res, 404, { error: 'no such client' });
  const host = tenant.host;
  if (req.method === 'GET' && route === '/v1/status') return statusRoute(host, res, tenant.scheduler);
  if (req.method === 'GET' && route === '/v1/usage') return usageRoute(host, url, res);
  if (req.method === 'GET' && route === '/v1/approvals') return approvalsRoute(host, url, res);
  if (req.method === 'GET' && route === '/v1/memory') return memoryRoute(host, url, res);
  if (req.method === 'POST' && route === '/v1/runs') return openRunRoute(host, req, res);
  const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(route);
  if (req.method === 'POST' && cancel) return cancelRoute(host, url, res, cancel[1]);
  const thread = /^\/v1\/threads\/([^/]+)$/.exec(route);
  if (req.method === 'GET' && thread) return threadRoute(host, url, res, thread[1]);
  return json(res, 404, { error: 'no such route' });
}
