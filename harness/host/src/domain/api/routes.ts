import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import * as z from 'zod/v4';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN, assertInsideRoot } from '@harness/shared';
import { cancelRun, runTurn, serialize, type TurnEvent } from '../conversation.js';
import type { Host } from '../host.js';
import { WITHHELD, findOrCreateThread } from '../threads/repository.js';
import { findRunFor, readThreadFor } from './repository.js';
import { sseStream } from './sse.js';
import { API_MAX_ATTACHMENTS, API_MAX_BODY_BYTES, API_MAX_TEXT_CHARS, type RunApiOptions } from './types.js';

/** A uuid, checked before it reaches Postgres: an id of any other shape is "no such thing", not an error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** `then` runs once the body is on the wire: what the 413 path hangs the socket's teardown on. */
function json(res: ServerResponse, status: number, body: unknown, then?: () => void): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body), then);
}

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

/**
 * Read the body, refusing past the cap while it arrives rather than after.
 *
 * Past the cap this stops consuming: the `data` handler comes off and the request is paused, so
 * nothing further is read off the socket and what was already held is released. It does not
 * destroy the connection — a 413 cannot be written down a socket this function has torn up, and a
 * caller told nothing learns nothing. The caller answers, and hangs the teardown on the answer
 * being flushed, so the read stays bounded either way.
 */
export async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > API_MAX_BODY_BYTES) {
        // Both, because removing the last `data` listener does not by itself stop a flowing stream.
        req.off('data', onData);
        req.pause();
        chunks = [];
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    // Already settled if the cap tripped; a promise keeps its first answer.
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false }));
  });
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
  // The 413 goes out first and the socket is torn up after it, so the caller is told why and a
  // caller that keeps sending anyway is cut off rather than read and discarded for as long as it
  // likes. Destroying before the flush would answer nothing; not destroying at all would let one
  // authenticated connection stream gigabytes past a cap that had already refused it.
  if (!body.ok) {
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
    stream.send('error', { type: 'error', message: 'the run failed; see the host log' });
  } finally {
    stream.end();
  }
}

/** Cancel a run of the caller's own (spec 5.8). Another principal's run is "no such run" (decision 18). */
async function cancelRoute(host: Host, url: URL, res: ServerResponse, runId: string): Promise<void> {
  const caller = await callerOf(host, {
    surface: url.searchParams.get('surface') ?? '',
    userId: url.searchParams.get('userId') ?? '',
  });
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
  const caller = await callerOf(host, {
    surface: url.searchParams.get('surface') ?? '',
    userId: url.searchParams.get('userId') ?? '',
  });
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
 * What this process is doing (decision 16): the surfaces it loaded, the runs in flight, and the
 * scheduler's own status, which had nowhere to be reported until this route existed.
 *
 * Counts and names only, never a conversation, a principal or a message — the same rule `/healthz`
 * follows, and for the same reason.
 */
function statusRoute(host: Host, res: ServerResponse, opts: RunApiOptions): void {
  json(res, 200, {
    client: host.client,
    surfaces: host.surfaces.all.map((session) => session.name),
    primary_surface: host.surfaces.primary.name,
    runs_in_flight: host.active.size,
    draining: host.draining,
    scheduler: opts.scheduler?.status() ?? null,
  });
}

/** Route one request. Every route is behind the bearer check, including the status one. */
export async function handleApiRequest(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunApiOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://run-api.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (!bearerOk(req.headers.authorization, opts.token)) return json(res, 401, { error: 'unauthorised' });
  if (req.method === 'GET' && route === '/v1/status') return statusRoute(host, res, opts);
  if (req.method === 'POST' && route === '/v1/runs') return openRunRoute(host, req, res);
  const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(route);
  if (req.method === 'POST' && cancel) return cancelRoute(host, url, res, cancel[1]);
  const thread = /^\/v1\/threads\/([^/]+)$/.exec(route);
  if (req.method === 'GET' && thread) return threadRoute(host, url, res, thread[1]);
  return json(res, 404, { error: 'no such route' });
}
