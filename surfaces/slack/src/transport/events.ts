import { WebClient } from '@slack/web-api';
import type { Logger } from '@harness/shared';
import type { SurfaceHttpRequest, SurfaceHttpResponse } from '@harness/surface-api';
import type { SlackConfig } from '../config.js';
import { classifyInbound, createThreadMemory, type BotIdentity } from './classify.js';
import { downloadAttachments } from './files.js';
import { verifySignature } from './signature.js';
import type {
  RawMessage,
  SlackAction,
  SlackApi,
  SlackEvents,
  SlackInbound,
  SlackTransport,
  SlackView,
} from './types.js';
import { webClientApi } from './web-client.js';

/**
 * Where Slack delivers: one URL for the Events API and for Interactivity alike.
 *
 * Both request URLs in an app's configuration point here. One handler rather than two because the
 * two payloads differ only in their content type, and two mounts would be two things to configure
 * and one more way for an app to be half set up.
 */
export const SLACK_MOUNT_PATH = 'slack/events';

/** An acknowledgement: 200 and nothing else, within the three seconds Slack allows. */
const ACK: SurfaceHttpResponse = { status: 200 };

/** The envelope of an Events API delivery, narrowed to what is read here. */
interface EventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: { type?: string; channel?: string; ts?: string } & Record<string, unknown>;
}

/** An interaction payload, narrowed to what is read here. */
interface InteractivePayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  trigger_id?: string;
  message?: { ts?: string };
  actions?: { action_id?: string; value?: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}

/** The two event types the classifier has rules for, and only when they carry what it reads. */
function inboundOf(envelope: EventEnvelope): RawMessage | null {
  const event = envelope.event;
  if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return null;
  if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return null;
  return event as unknown as RawMessage;
}

/**
 * A real Slack connection, over HTTPS, holding no socket.
 *
 * The host mounts `http` at `/tenants/<clientId>/slack/events` and hands over every request that
 * arrives there. Nothing here is connected: `start()` asks Slack who this app is and that is all
 * it does, so a paused host resumes by answering its next request, and a pooled host serves as
 * many workspaces as it has tenants — which is the whole reason socket mode goes (spec decision
 * 9).
 *
 * **Acknowledge, then run.** Slack retries a delivery it has not heard about within three seconds
 * and a turn takes seconds to minutes, so every accepted request is answered before the work
 * starts and the work is reported to the log if it fails. A retried delivery is dropped rather
 * than deduplicated: the only duplicate this can see is one Slack sent, the first copy is already
 * in flight or finished, and a table of event ids is a write on the hot path plus a sweep. The
 * other half of that trade, said out loud: an event acknowledged and not yet run is lost if this
 * process dies, and the retry that would have rescued it is refused by the same rule. A message
 * answered once and slowly is the thing being bought, and a lost turn in a crash is the price.
 *
 * Both interaction registrations are catch-alls, as the socket's were: the contract takes one
 * action handler and one view handler and dispatches on the id itself, so there is nothing to
 * route here. An interaction this host did not post is acknowledged and dropped by the handler
 * above rather than ignored here — acknowledging something unknown costs nothing, and leaving it
 * unacknowledged shows a person an error for a message this host has no opinion about.
 *
 * `api` is a parameter with a default rather than a construction, for one reason: `start()` calls
 * `auth.test`, and every other Web API call this transport makes goes through the same slice, so
 * a suite that could not substitute `FakeSlack` here would reach slack.com. `index.ts` calls this
 * with three arguments and gets a real `WebClient`.
 */
export function eventsTransport(
  config: SlackConfig,
  log: Logger,
  storageDir: string,
  api: SlackApi = webClientApi(new WebClient(config.botToken)),
): SlackTransport {
  const threads = createThreadMemory(api, log);

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;
  let messageHandler: ((message: SlackInbound) => Promise<void>) | null = null;
  /** Who this app is, once `auth.test` has said. Read only behind `identified`. */
  let bot: BotIdentity = {};
  let identity: Promise<void> | null = null;

  /**
   * Ask Slack who this app is, once per process, and remember the asking rather than the answer.
   *
   * The host publishes a tenant into its map before it starts that tenant's sessions, so a
   * delivery can reach this door while the answer is still in flight. Classifying against an empty
   * identity is not a smaller version of classifying correctly: the mention token is left in the
   * text the runtime is handed, the channel copy of an `app_mention` stops being recognised as the
   * duplicate it is, and a thread lookup caches the thread as somebody else's for as long as the
   * process lives. So the fetch is memoised as a promise and everything that needs an identity
   * waits on it — whichever of `start()` and a request asks for it first.
   *
   * Not begun when the transport is built: `connect` reaches nothing, which is what lets a client
   * document be loaded and its surfaces built without a workspace answering.
   */
  const identified = (): Promise<void> => {
    identity ??= api.auth.test().then((result) => {
      bot = { userId: result.user_id, botId: result.bot_id };
    });
    return identity;
  };

  /** Whether this app knows who it is. A rejection is an answer here, not an escape. */
  const hasIdentity = (): Promise<boolean> =>
    identified().then(
      () => true,
      () => false,
    );

  /**
   * Start work this request has already been acknowledged for; a failure is a log line.
   *
   * On a later tick rather than now. `void run()` alone would still execute everything up to the
   * turn's first real suspension before this returns, so the work would begin before the 200 it is
   * owed had even been built — which is the one ordering this whole transport is arranged around.
   * Slack is answered first, and the work starts once it has been.
   */
  const later = (what: string, run: () => Promise<void>): void => {
    setImmediate(() => {
      // `try` as well as `catch`: a handler that threw where it stands rather than rejecting would
      // escape a bare `.catch` and, at the top of the event loop, take the process down with it.
      // Every handler this package wires is `async`, but this is a seam somebody else registers on.
      try {
        void run().catch((err: unknown) => log.error(`${what} failed`, err));
      } catch (err: unknown) {
        log.error(`${what} failed`, err);
      }
    });
  };

  const deliver = async (raw: RawMessage, teamId: string | undefined): Promise<void> => {
    const handler = messageHandler;
    if (!handler) {
      log.warn('a Slack message arrived before a handler was registered');
      return;
    }
    const classified = await classifyInbound(raw, bot, threads);
    if (!classified) return;
    // The reply the host writes names this message, and only the transport sees which thread it
    // belongs to: a mention inside an existing thread carries a root that is not its own
    // timestamp. Recorded only for a message that will be answered, so ordinary channel chatter
    // does not fill the store.
    if (classified.mentioned) threads.noteInbound(raw.channel, raw.ts, raw.thread_ts ?? raw.ts);
    // Nothing to download, nothing to touch: `downloadAttachments` creates `<storageDir>/incoming`
    // before it looks at its list, and almost every message carries no file at all. Skipping the
    // call leaves the answer identical — an empty list either way — and keeps the ordinary message
    // path off the disk entirely.
    const files =
      classified.files.length === 0
        ? []
        : await downloadAttachments(raw.ts, classified.files, { token: config.botToken, storageDir, log });
    await handler({
      userId: classified.userId,
      channel: raw.channel,
      text: classified.text,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      mentioned: classified.mentioned,
      files,
      // The event's own `team` where Slack sends one, and the envelope's otherwise: a delivery
      // carries the workspace on the envelope, and the two agree.
      teamId: raw.team ?? teamId ?? null,
    });
  };

  const handleEvent = (body: string): SurfaceHttpResponse => {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(body) as EventEnvelope;
    } catch {
      return { status: 400, refusal: { reason: 'bad_request' } };
    }
    // The one-time handshake when a request URL is saved in an app's configuration. It is signed
    // like everything else, so this answers only a URL whose secret is already right.
    if (envelope.type === 'url_verification') {
      if (typeof envelope.challenge !== 'string') return { status: 400, refusal: { reason: 'bad_request' } };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: envelope.challenge }),
      };
    }
    const raw = envelope.type === 'event_callback' ? inboundOf(envelope) : null;
    if (raw) {
      const teamId = envelope.team_id;
      later('a Slack delivery', () => deliver(raw, teamId));
    }
    return ACK;
  };

  const handleInteractive = (body: string): SurfaceHttpResponse => {
    const raw = new URLSearchParams(body).get('payload');
    if (raw === null) return { status: 400, refusal: { reason: 'bad_request' } };
    let payload: InteractivePayload;
    try {
      payload = JSON.parse(raw) as InteractivePayload;
    } catch {
      return { status: 400, refusal: { reason: 'bad_request' } };
    }
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      const handler = actionHandler;
      if (!action) return ACK;
      if (!handler) {
        log.warn('a Slack action arrived before a handler was registered');
        return ACK;
      }
      const mapped: SlackAction = {
        userId: payload.user?.id ?? 'unknown',
        // The channel the interactive message lives in.
        channel: payload.channel?.id ?? '',
        actionId: action.action_id ?? '',
        value: action.value ?? '',
        triggerId: payload.trigger_id ?? null,
        messageTs: payload.message?.ts ?? null,
      };
      later('a Slack action', () => handler(mapped));
      return ACK;
    }
    if (payload.type === 'view_submission') {
      const view = payload.view;
      const handler = viewHandler;
      if (!view) return ACK;
      if (!handler) {
        log.warn('a Slack view submission arrived before a handler was registered');
        return ACK;
      }
      const mapped: SlackView = {
        userId: payload.user?.id ?? 'unknown',
        callbackId: view.callback_id ?? '',
        privateMetadata: view.private_metadata ?? '',
        state: view.state?.values ?? {},
      };
      later('a Slack view submission', () => handler(mapped));
      // An empty 200 closes the modal, which is what accepting a submission means.
      return ACK;
    }
    return ACK;
  };

  /**
   * What can be decided about a request before anything about this app is known, or null to carry
   * on. Everything here is a property of the request itself.
   */
  const screen = (request: SurfaceHttpRequest): SurfaceHttpResponse | null => {
    const check = verifySignature({
      signature: request.headers['x-slack-signature'],
      timestamp: request.headers['x-slack-request-timestamp'],
      body: request.body,
      secret: config.signingSecret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    // Before the body is parsed and before anything else is read off it (invariant 15). The host
    // writes the one audit row; this says only which kind of refusal it was.
    if (!check.ok) {
      return { status: check.reason === 'stale_timestamp' ? 400 : 401, refusal: { reason: check.reason } };
    }
    // After the signature, so an unverified request cannot suppress a retry it invented, and
    // before the content-type branch, so one rule covers everything that arrives here. Only the
    // Events API retries — Slack does not resend an interaction — so for an interactivity POST
    // this is a branch that never fires rather than behaviour anyone depends on.
    if (request.headers['x-slack-retry-num'] !== undefined) {
      log.warn('a retried Slack delivery was dropped; the first one is in flight or already done');
      return { status: 200, headers: { 'x-slack-no-retry': '1' } };
    }
    return null;
  };

  /**
   * The answer to a screened request, which nothing here waits for.
   *
   * Deliberately synchronous: every branch either refuses or acknowledges, and the work an
   * acknowledgement admits to is handed to `later`. Making this a plain function is what says so —
   * an `async` here would leave room for someone to await a turn before answering Slack.
   */
  const dispatch = (request: SurfaceHttpRequest): SurfaceHttpResponse => {
    // Lower-cased because a media type is case-insensitive and only the value's own case is ours
    // to normalise; Slack sends lowercase, and a peer that did not would be refused for nothing.
    const contentType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType === 'application/json') return handleEvent(request.body);
    if (contentType === 'application/x-www-form-urlencoded') return handleInteractive(request.body);
    return { status: 415, refusal: { reason: 'unsupported_media_type' } };
  };

  const handle = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    const refused = screen(request);
    if (refused) return refused;
    // Before anything is classified, and after the signature, so an unsigned request can neither
    // wait on this nor learn anything from it. Once the answer is in hand this is a microtask; in
    // the window before it, a delivery waits rather than being read against an empty identity.
    if (!(await hasIdentity())) {
      return { status: 503, refusal: { reason: 'identity_unavailable' } };
    }
    return dispatch(request);
  };

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    /**
     * Ask Slack who this app is. That is the whole of starting: nothing is connected.
     *
     * The bot's own user id is what the mention stripper removes and what the thread rule matches
     * a thread's messages against, and a socket's connection context used to carry both. Awaiting
     * the same promise every delivery waits on means a wrong token fails this tenant's open,
     * loudly, instead of quietly classifying every message as though nobody had been mentioned.
     */
    async start() {
      await identified();
      log.info('ready for Slack events over HTTPS');
    },
    /**
     * Nothing to close. The handlers are dropped so a tenant that is shutting down cannot be
     * delivered into by a request that arrives while its surfaces are being stopped.
     */
    stop() {
      actionHandler = null;
      viewHandler = null;
      messageHandler = null;
      return Promise.resolve();
    },
  };

  return {
    api,
    events,
    notePostedIn: (channel, threadTs) => threads.notePostedIn(channel, threadTs),
    http: { path: SLACK_MOUNT_PATH, handle },
  };
}
