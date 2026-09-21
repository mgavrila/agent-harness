import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  CONVERSATION_ID_PATTERN,
  assertInsideRoot,
  type ActionEvent,
  type FormEvent,
  type MessageEvent,
  type MessageRef,
  type SurfaceHttp,
  type SurfaceHttpRequest,
  type SurfaceHttpResponse,
} from './deps.js';
import type { ConversationStreams } from './stream.js';

/**
 * Where the workspace reaches this tenant: `/tenants/<clientId>/web/...`.
 *
 * One mount, four routes under it. The host resolves the tenant from the path before this handler
 * is called and hands the rest of it over as `request.path`, so nothing here ever sees, or has to
 * agree with, the prefix in front of it.
 */
export const WEB_MOUNT_PATH = 'web';

/** One message. Longer than any person writes, and shorter than a document, which belongs in `incoming/`. */
export const WEB_MAX_TEXT_CHARS = 10_000;
/** How many attachments one message may name. The run API's own cap, for the same reason. */
export const WEB_MAX_ATTACHMENTS = 10;
/**
 * How long one of the short fields may be: a user id, an action id, a form id, a button's value.
 *
 * Every one of them is an identifier somebody else minted, and each is handed on to somewhere a
 * long string costs more than it is worth — a value reaches the approvals log line when the
 * presser turns out not to be an approver, so an uncapped one would be a caller writing a page
 * into a deployment's log.
 */
export const WEB_MAX_FIELD_CHARS = 200;

/** A conversation's event stream: `GET web/conversations/<id>/events`. */
const EVENTS_ROUTE = /^conversations\/([^/]+)\/events$/;

/** What the door needs from the session to do its work. The session owns all of it. */
export interface WebInbound {
  readonly token: string;
  readonly storageDir: string;
  readonly streams: ConversationStreams;
  /** The reference this message gets, which is what the caller is answered with. */
  inboundRef(conversation: string): MessageRef;
  /** An opaque handle this surface accepts back in `openForm`, minted per delivered action. */
  triggerFor(message: MessageRef): string;
  /**
   * The metadata the form with this id was opened with on this card, and forget it; null when
   * this session opened no such form, or when that form has already been submitted.
   */
  takeForm(message: MessageRef, formId: string): string | null;
  deliver(what: string, run: () => Promise<void>): void;
  message(event: MessageEvent): Promise<void>;
  action(event: ActionEvent): Promise<void>;
  form(event: FormEvent): Promise<void>;
}

/** Every answer this door gives that carries JSON, typed so a client can be coded against it. */
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const json = (status: number, body: unknown): SurfaceHttpResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** A refusal the host audits exactly once, with a reason it can group by. */
const refused = (reason: string, error: string): SurfaceHttpResponse => ({
  ...json(401, { error }),
  refusal: { reason },
});

const badRequest = (what: string): SurfaceHttpResponse => json(400, { error: what });

/**
 * What a submission naming a dialogue this session has no record of is told.
 *
 * One fixed sentence for both ways it happens — a card this session never opened a form on, and a
 * form already submitted — because they are the same thing from the workspace's side and telling
 * the two apart would say whether a given card exists here.
 */
const NO_SUCH_FORM = 'that form is not open on this surface';

/**
 * Constant-time on the bytes, after a length check.
 *
 * This adapter's own, and not the host's `bearerOk`: `pnpm arch` allows a surface to import
 * `@harness/surface-api` and `@harness/shared` and nothing else, and the host's copy is in
 * neither. The shape is the same and so is the reason — `timingSafeEqual` throws on a length
 * mismatch, and comparing lengths first leaks only the token's length, which a caller who can
 * measure a comparison could learn anyway.
 */
function bearerOk(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const offered = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** A parsed object, or null for anything a field cannot be read off. */
function objectBody(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** A non-empty string no longer than `max`, or null. Deliberately not a zod schema: it is a string. */
function stringField(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}

/** A message reference the workspace got from a frame, narrowed to what is read off it. */
function messageRef(value: unknown): MessageRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const ref = value as { surface?: unknown; conversation?: unknown; id?: unknown };
  const conversation = stringField(ref.conversation, WEB_MAX_FIELD_CHARS);
  const id = stringField(ref.id, WEB_MAX_FIELD_CHARS);
  if (ref.surface !== 'web' || conversation === null || id === null) return null;
  if (!CONVERSATION_ID_PATTERN.test(conversation)) return null;
  return { surface: 'web', conversation, id };
}

/** `[{ name, path }]`, capped, or null when the field is present and is not that. */
function attachments(value: unknown): { name: string; path: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WEB_MAX_ATTACHMENTS) return null;
  const out: { name: string; path: string }[] = [];
  for (const entry of value as { name?: unknown; path?: unknown }[]) {
    const name = stringField(entry?.name, 255);
    const file = stringField(entry?.path, 512);
    if (name === null || file === null) return null;
    out.push({ name, path: file });
  }
  return out;
}

/**
 * The four routes, and one bearer in front of all of them.
 *
 * **The bearer is checked first**, before the method, before the route and before a byte of the
 * body is parsed (invariant 20): a caller who cannot authenticate learns neither which routes
 * exist nor whether their body was readable. Every other refusal below is a caller's mistake
 * rather than a door turning somebody away, so none of them carries a `refusal` and none of them
 * costs an audit row.
 */
export function createDoor(inbound: WebInbound): SurfaceHttp {
  const handleMessage = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, WEB_MAX_FIELD_CHARS);
    const conversation = stringField(body.conversation, WEB_MAX_FIELD_CHARS);
    const text = stringField(body.text, WEB_MAX_TEXT_CHARS);
    if (userId === null) return badRequest('userId is required');
    if (conversation === null || !CONVERSATION_ID_PATTERN.test(conversation)) {
      return badRequest('conversation is a conversation id: no spaces and no control characters');
    }
    if (text === null) return badRequest(`text is required and may be at most ${WEB_MAX_TEXT_CHARS} characters`);
    const files = attachments(body.attachments);
    if (files === null) return badRequest(`attachments are at most ${WEB_MAX_ATTACHMENTS} entries of { name, path }`);
    // A path that came from a caller, checked against the one directory a caller may name. Every
    // other adapter stages its own files and its paths are trustworthy by construction; these are
    // not, which is why the run API checks the same thing in the same way.
    const incoming = path.join(inbound.storageDir, 'incoming');
    for (const [index, file] of files.entries()) {
      try {
        await assertInsideRoot(
          file.path,
          incoming,
          () => {
            throw new Error('outside');
          },
          { allowRoot: false },
        );
      } catch {
        // The position in the list the caller sent, which is this door's own number: naming the
        // attachment would put a caller's string back in the answer, and every other refusal here
        // repeats nothing of what was sent.
        return badRequest(`attachment ${index + 1} is not a path inside the incoming directory`);
      }
    }
    const ref = inbound.inboundRef(conversation);
    // Acknowledge, then run. A turn takes seconds to minutes and the caller is not waiting for it:
    // the reply arrives on this conversation's stream.
    inbound.deliver('a web message', () =>
      inbound.message({
        surface: 'web',
        userId,
        conversation,
        text,
        attachments: files,
        message: ref,
        // Every message on this surface is addressed to the assistant: a workspace that is talking
        // to its agent has no channel chatter to overhear.
        mentioned: true,
        // The tenant the host resolved from the mount path. **Not `deps.tenantKey`**: both would
        // work and this is the one that cannot be misconfigured (spec section 4.9).
        tenantHint: request.clientId,
      }),
    );
    return json(202, { message: ref });
  };

  const handleAction = (request: SurfaceHttpRequest): SurfaceHttpResponse => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, WEB_MAX_FIELD_CHARS);
    const actionId = stringField(body.actionId, WEB_MAX_FIELD_CHARS);
    const value = stringField(body.value, WEB_MAX_FIELD_CHARS);
    const ref = messageRef(body.messageRef);
    if (userId === null) return badRequest('userId is required');
    if (actionId === null) return badRequest('actionId is required');
    if (value === null) return badRequest('value is required');
    if (ref === null) return badRequest('messageRef is a reference this surface handed out');
    inbound.deliver('a web action', () =>
      inbound.action({
        surface: 'web',
        userId,
        conversation: ref.conversation,
        message: ref,
        actionId,
        value,
        trigger: inbound.triggerFor(ref),
      }),
    );
    return json(202, {});
  };

  const handleForm = (request: SurfaceHttpRequest): SurfaceHttpResponse => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, WEB_MAX_FIELD_CHARS);
    const formId = stringField(body.formId, WEB_MAX_FIELD_CHARS);
    const ref = messageRef(body.messageRef);
    if (userId === null) return badRequest('userId is required');
    if (formId === null) return badRequest('formId is required');
    if (ref === null) return badRequest('messageRef is a reference this surface handed out');
    const values: Record<string, string> = {};
    const raw = body.values;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return badRequest('values is an object');
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'string') return badRequest('every value is a string');
      values[key] = entry;
    }
    // The host's own string, handed back untouched: the adapter remembered it when it opened the
    // form on this card and has never read it. Taken rather than read, and the answer decides
    // whether this submission is delivered at all — a form this session did not open, or one that
    // has already been submitted, is not a dialogue the host can answer. Delivering it with an
    // empty string would be worse than refusing: the metadata is what names the approval, so an
    // empty one reaches the decision path as a submission about nothing.
    const metadata = inbound.takeForm(ref, formId);
    if (metadata === null) return badRequest(NO_SUCH_FORM);
    inbound.deliver('a web form submission', () =>
      inbound.form({
        surface: 'web',
        userId,
        conversation: ref.conversation,
        formId,
        metadata,
        values,
      }),
    );
    return json(202, {});
  };

  const handle = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    if (!bearerOk(request.headers.authorization, inbound.token)) {
      return refused('bad_bearer', 'unauthorised');
    }
    const events = EVENTS_ROUTE.exec(request.path);
    if (events) {
      if (request.method !== 'GET') return { status: 405, headers: { allow: 'GET' } };
      // The same shape `POST …/web/messages` requires of a conversation. Without it a caller
      // could open a stream on an id it could never write to — nothing grows, because `open`
      // only reads the map, but one route accepting what the other refuses is the kind of
      // difference a client is eventually written against.
      if (!CONVERSATION_ID_PATTERN.test(events[1])) return badRequest('conversation is a conversation id');
      return {
        status: 202,
        // The three headers that stop something in between buffering a stream into one response,
        // and the status the run API's own stream answers with: the request is accepted, and what
        // follows is the conversation happening.
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        body: inbound.streams.open(events[1], request.signal, request.headers['last-event-id'] ?? null),
      };
    }
    if (request.path === 'messages' || request.path === 'actions' || request.path === 'forms') {
      if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
      if (request.path === 'messages') return handleMessage(request);
      return request.path === 'actions' ? handleAction(request) : handleForm(request);
    }
    return json(404, { error: 'no such route' });
  };

  return { path: WEB_MOUNT_PATH, handle };
}
