import type { EnvSource, Logger, SurfaceDirectory } from '@harness/shared';

/**
 * Every declaration of the surface contract, in one leaf module.
 *
 * The same arrangement `@harness/pack-api` uses, and for the same reason: `surface.ts`,
 * `models.ts` and `testing.ts` re-export from here and keep their own runtime functions, so no
 * two modules of this package can end up importing each other. It imports types from
 * `@harness/shared` and nothing else.
 */

/** Where a message can go on a named surface. What a row or an outbox payload stores. */
export interface Conversation {
  surface: string;
  /** The conversation's id in that surface's own shape. */
  id: string;
}

/** One message, addressable again later: to edit it, or to reply under it. */
export interface MessageRef {
  surface: string;
  conversation: string;
  /** The surface's own id for the message: a Slack `ts`, a Teams activity id, a Telegram message id. */
  id: string;
}

/** The two outcomes a card reports. An adapter picks its own glyph. */
export type CardIcon = 'approved' | 'declined';

/**
 * One piece of a rich line.
 *
 * Small on purpose: every surface can render all five. Slack turns `{ at }` into a `<!date>`
 * token that reads in the viewer's own timezone and `{ user }` into a mention; a surface with
 * neither prints an ISO timestamp and an `@id`. A host never formats a date or spells a
 * mention itself, because a host that did would have picked a surface.
 */
export type NotePart = { text: string } | { code: string } | { at: Date } | { user: string } | { icon: CardIcon };

/**
 * One line of a card's body. Each renders as its own block.
 *
 * `{ note }` is the dimmer line a surface renders smaller — Slack's `context` block — and is the
 * only line that carries rich parts. A note that has to span several visual lines carries
 * `{ text: '\n' }` parts between them; the host builds those, so the adapter joins nothing.
 */
export type CardLine =
  { text: string } | { label: string; value: string } | { code: string } | { note: readonly NotePart[] };

/** One button. `id` is what comes back on the `ActionEvent`; `value` is what it carries. */
export interface CardAction {
  id: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  value: string;
}

/**
 * A message a human acts on.
 *
 * Neutral by construction: no Block Kit, no Adaptive Card, no inline keyboard. An adapter
 * renders it; the host never sees a rendered shape.
 */
export interface Card {
  /**
   * A stable identifier for this *kind* of card, not for one instance of it. An adapter that
   * needs to name the card's parts derives the names from it — the Slack adapter's actions
   * block is `` `${card.id}_actions` `` — so two cards of different kinds never collide.
   */
  id: string;
  title: string;
  /** One line of plain text under the title, in the same block. */
  subtitle?: string;
  /**
   * One line of plain text for wherever the card itself cannot go: a notification preview, a
   * surface that renders no rich content. Required, because it is the only thing some readers
   * ever see — and because a posted card and its edited replacement usually want to say
   * different things.
   */
  notice: string;
  body: readonly CardLine[];
  /** Empty for a card that has been acted on already. */
  actions: readonly CardAction[];
  footer?: readonly NotePart[];
}

export interface FormField {
  /** Stable; it is the key this field's answer comes back under on the `FormEvent`. */
  id: string;
  label: string;
  multiline: boolean;
  optional: boolean;
  maxLength?: number;
  placeholder?: string;
}

/** A short dialogue a surface may be able to open. `metadata` is opaque to the adapter. */
export interface Form {
  /** Stable; it is what comes back as `FormEvent.formId`. */
  id: string;
  title: string;
  submitLabel: string;
  cancelLabel: string;
  /** A sentence above the fields, saying what submitting does. */
  intro?: string;
  fields: readonly FormField[];
  /**
   * The host's own string, carried out with the form and handed back on submission untouched.
   * A surface stores it wherever it can (Slack: `private_metadata`) and never reads it.
   */
  metadata: string;
}

/** A human pressed a button. */
export interface ActionEvent {
  surface: string;
  userId: string;
  conversation: string;
  /** The message the button was on, when the surface says which. */
  message: MessageRef | null;
  actionId: string;
  value: string;
  /** An opaque handle this surface will accept back in `openForm`, for as long as it lasts. */
  trigger: string | null;
}

/**
 * A human submitted a form. `values` is keyed by `FormField.id`.
 *
 * `conversation` may be empty, and a host must cope with that rather than trust it: a surface
 * that opens a form from a button on a card has no conversation of its own to report on the
 * submission. The host recovers one from `metadata`, which is its own string and comes back
 * untouched, which is why anything a host needs on the way back belongs in there.
 */
export interface FormEvent {
  surface: string;
  userId: string;
  conversation: string;
  formId: string;
  metadata: string;
  values: Record<string, string>;
}

/**
 * What this surface can do beyond posting.
 *
 * The host reads these rather than trying and catching: a card offered on a surface with no
 * `forms` simply has no Edit button, which is honest, and needs no fallback protocol.
 */
export interface SurfaceCapabilities {
  forms: boolean;
  privateReply: boolean;
  update: boolean;
  /** `startStream` works. Off, the host posts the whole reply once. */
  streaming: boolean;
  /** A card's buttons can sit in the conversation the question was asked in. Unused until a surface has it. */
  inlineConfirm: boolean;
}

/** A human wrote to the assistant. Attachments are already under `<storageDir>/incoming`; `path` is relative to it. */
export interface MessageEvent {
  surface: string;
  userId: string;
  conversation: string;
  text: string;
  attachments: readonly { name: string; path: string }[];
  /** The message itself, when the surface can address it again. */
  message: MessageRef | null;
  /**
   * True when the assistant was addressed: mentioned in a channel, or written to directly. A
   * direct message is addressed by construction, so an adapter sets this true there too. The
   * host answers only when this is true.
   */
  mentioned: boolean;
  /**
   * Whatever identifies the workspace this event came from, in the surface's own terms — the
   * organisation, the team, the tenant of whatever the transport calls one — or absent for a
   * surface with no such notion.
   *
   * Opaque to the host, which matches it against the keys each client's document declares and
   * never reads it as anything but a string. That is how one process serves several clients on
   * one transport without the host learning a vendor's field name.
   */
  tenantHint?: string;
}

/**
 * Why a text is being posted, for a surface whose behaviour turns on it.
 *
 * `reply` is a turn's own answer and is the default. `notice` is something the host says *about* a
 * message rather than in answer to it — that the writer is not authorised, say. The difference
 * matters where a surface treats a thread the assistant has spoken in as addressed to it: a reply
 * makes the thread a conversation, a notice must not, or the person it refused would be answered
 * with another notice for every line they write there afterwards.
 */
export type PostKind = 'reply' | 'notice';

/** A reply being written as it is produced. `end` posts what is left and returns the message. */
export interface StreamHandle {
  append(delta: string): void;
  end(): Promise<MessageRef>;
}

export interface UploadRequest {
  /** An absolute path the host has already checked. The adapter reads it and sends the bytes. */
  path: string;
  filename: string;
  comment?: string;
  replyTo?: MessageRef;
}

/**
 * One inbound request, as a surface's own transport understands it.
 *
 * `body` is the bytes exactly as they arrived, decoded as UTF-8 and not parsed: a signature is
 * computed over them, and a handler that was given a parsed object could not check one. **The
 * seam is text, not bytes**, which is lossless for the UTF-8 every transport in question sends
 * and is worth knowing for the one that does not: an invalid byte sequence decodes to U+FFFD, so
 * its signature is computed over something other than what arrived and the request is refused as
 * badly signed rather than as malformed. A transport that must sign arbitrary bytes needs this
 * field widened, and that is a contract change rather than a workaround. `path` is what is left
 * of the URL below this surface's mount — empty for the mount itself — so an adapter never sees,
 * and never has to agree with, the tenant prefix the host put in front of it.
 * `headers` are lower-cased, and each value is the one the host's HTTP parser produced. **A
 * header sent twice is the folded value, not the first one** — most names arrive joined with
 * `", "`, `cookie` with `"; "` — because the parser folds them before the host sees them and the
 * first value is not recoverable afterwards. A transport that signs its requests does not send
 * its signature twice, so this is the safe direction: a signature computed over one value does
 * not match the join, and the handler refuses a duplicated header instead of accepting whichever
 * of the two an attacker appended. A handler that wants to be explicit about it can refuse a
 * signature header containing a separator.
 */
export interface SurfaceHttpRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  /**
   * The tenant this request is for: the client id the host resolved out of the mount path before
   * it called this handler.
   *
   * It is here rather than on `SurfaceDeps` because it is a property of the request and not of
   * the session — and because it is the one value that cannot be misconfigured. An adapter that
   * has to report which tenant an event belongs to reports this: it is what the host routed on a
   * moment earlier, so a document whose key and id drifted apart cannot make an adapter claim a
   * tenant the host did not route to.
   */
  clientId: string;
  /**
   * Aborted when the caller goes away.
   *
   * A handler that answers with a whole body may ignore it. One that answers with a stream selects
   * on it and returns, so a closed browser tab does not leave a producer pushing frames into a
   * socket nobody is reading. It is also aborted after an ordinary response has been sent, because
   * what the host listens for is the response closing; a handler that has already returned has
   * nothing left to cancel, so that costs nothing.
   */
  signal: AbortSignal;
}

/**
 * What the host sends back, and whether it was a refusal.
 *
 * `refusal` is the one field the host reads for itself: when it is set, exactly one `audit_log`
 * row is written before the response goes out (invariant 15), and `reason` is a short token — see
 * `SURFACE_REFUSAL_REASON_PATTERN` — because it lands in a column an operator groups by. Nothing
 * of the request body reaches that row: a refused request has not been authenticated, so there is
 * nothing in it worth recording. A surface never writes audit itself; it may import only this
 * contract, `@harness/shared` and its own modules.
 *
 * **A refusal is decided before the first byte.** The host reads this field, writes its one audit
 * row and then sends the head; once the head is written the response is a stream and there is
 * nothing left to declare. An adapter that discovers a problem mid-stream says so in its own
 * frames and ends.
 */
export interface SurfaceHttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  /**
   * The whole answer, or the answer as it is produced.
   *
   * A **string** is sent in one write and the response ends: an acknowledgement, a JSON body, a
   * challenge. An **async iterable of strings** is a stream: the host writes the head, writes each
   * chunk as it is yielded — waiting for the socket to drain, or for the client to go away — and
   * ends the response when the iterable ends. A chunk is opaque: the host does not know whether it
   * is a Server-Sent Events frame, a line of NDJSON or a fragment of a file, which is what keeps a
   * transport's framing inside the adapter that owns it.
   *
   * A throw out of the iterable is logged the way a throwing `handle` already is and closes the
   * response. There is **no error frame**, because the frame vocabulary is the adapter's: an
   * adapter that wants to tell its client something before it stops yields that something first.
   */
  body?: string | AsyncIterable<string>;
  refusal?: { reason: string };
}

/**
 * A surface that can be reached by a request rather than by a socket it opened itself.
 *
 * The host mounts this at `/tenants/<clientId>/<path>` on its own HTTP server, one rule for a
 * dedicated deployment and a pooled one alike, and resolves the tenant from the path before it
 * calls `handle`. `path` carries no leading slash and is matched whole or as a prefix of one:
 * `slack/events` answers `/tenants/acme/slack/events` with `path: ''` and
 * `/tenants/acme/slack/events/extra` with `path: 'extra'`.
 *
 * Whatever authenticates the request is this surface's business and nobody else's — a signature
 * over the raw body, a shared token, an upstream header — because it is the transport's own
 * scheme, and the host would have to name a vendor to know about it.
 */
export interface SurfaceHttp {
  readonly path: string;
  handle(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse>;
}

/**
 * A connected surface.
 *
 * Every method that talks to the outside world rejects with a `SurfaceError` whose message is
 * safe to write into a plaintext column: it names the surface and what failed, never a path, a
 * token or a payload value.
 */
export interface SurfaceSession {
  /** This adapter's name, as the client document named it and as `approvals.surface` stores it. */
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  /** Where this surface posts when nobody names a conversation. */
  readonly defaultConversation: string;
  /**
   * Who this surface's users are and what groups they are in, when it can say.
   *
   * Optional: a transport with no notion of a directory simply does not offer one, and an
   * identity plug-in that wanted one is told so at load rather than at the first message.
   */
  readonly directory?: SurfaceDirectory;
  /**
   * Where this surface is reached by a request, when it is reached that way at all.
   *
   * Optional, and absent for a surface that opens its own connection or has no transport: a host
   * mounts what it is offered and nothing else. Spec section 4.6 — this is what lets the Slack
   * adapter hold the Events API without the host holding a Slack-shaped route.
   */
  readonly http?: SurfaceHttp;
  /** How this surface spells a mention of a user inside plain text. */
  mention(userId: string): string;
  /**
   * Post a card and say where it landed.
   *
   * Two rejections, and the difference is what the host does next. A plain `SurfaceError` means
   * nothing reached the conversation, so the host is free to post the card again. A
   * `SurfaceAcceptedError` means the transport took it and only the reference is missing: a card
   * is live, a human can press its buttons, and posting again would put a duplicate beside it.
   * An adapter whose send call succeeds but returns no id raises the second one, never the first.
   */
  postCard(conversation: string, card: Card): Promise<MessageRef>;
  /** Rejects with a `SurfaceError` when `capabilities.update` is false. */
  updateCard(ref: MessageRef, card: Card): Promise<void>;
  postText(conversation: string, text: string, opts?: { replyTo?: MessageRef; kind?: PostKind }): Promise<MessageRef>;
  /** Rejects with a `SurfaceError` when `capabilities.privateReply` is false. */
  postPrivate(conversation: string, userId: string, text: string): Promise<void>;
  uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }>;
  /** Rejects with a `SurfaceError` when `capabilities.forms` is false. */
  openForm(trigger: string, form: Form): Promise<void>;
  /** One handler for every button on this surface. Replaces any previous one. */
  onAction(handler: (event: ActionEvent) => Promise<void>): void;
  /** One handler for every form submitted on this surface. Replaces any previous one. */
  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void;
  /** One handler for every message written to the assistant on this surface. Replaces any previous one. */
  onMessage(handler: (event: MessageEvent) => Promise<void>): void;
  /**
   * Begin a streamed reply. Throws `SurfaceError` when `capabilities.streaming` is false. `recipient`
   * is the user the reply is for, for a surface whose streaming API wants one.
   */
  startStream(conversation: string, opts?: { replyTo?: MessageRef; recipient?: string }): StreamHandle;
  /** Show that a reply is coming, where the surface can. Optional. */
  typing?(conversation: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What an adapter is handed when it connects.
 *
 * `env` is the only environment an adapter may read — never the ambient one — for the same
 * reason a pack reads `deps.env`: whoever builds the bag decides what the adapter can see, so a
 * test suite cannot open a real socket because the machine running it has a filled-in `.env`.
 */
export interface SurfaceDeps {
  env: EnvSource;
  log: Logger;
  /** The root of the file store. An adapter that stages nothing may ignore it. */
  storageDir: string;
  /**
   * The opaque key this client's document declares for *this* surface, when it declares one.
   *
   * The counterpart of `MessageEvent.tenantHint`: the host matches an inbound event's hint
   * against these keys. An adapter whose transport reports the workspace an event came from
   * ignores this and reports what it saw; one with no such notion — the memory surface — has
   * nothing to read it off an event and answers with what the document declared. Absent for a
   * client that declared no key for this surface.
   */
  tenantKey?: string;
  /**
   * Where this surface posts when nobody names a conversation, when the client's document names
   * one.
   *
   * `SurfaceSession.defaultConversation` is what the host reads, and this is where it comes from:
   * the document names it and the host passes it through, opaquely, exactly as it passes
   * `tenantKey`. A deployment-wide variable cannot answer it, because a pooled host has one
   * environment and many tenants; an adapter that is handed nothing here has no per-tenant
   * conversation and answers with whatever default it has of its own.
   */
  defaultConversation?: string;
  /**
   * This client's credentials for this surface, resolved to their values, keyed by the document's
   * own field name — `{ botToken: 'xoxb-…' }`.
   *
   * The counterpart of `Surface.secrets`, which says which *variables* an adapter reads when it
   * is given nothing: this is what **this tenant** actually holds, resolved by the host from its
   * document's `SecretRef`s through whatever secret source the deployment configured. An adapter
   * falls back to the conventional variable for a field the document did not name, so a
   * single-tenant deployment configures nothing; two tenants in one process each get their own,
   * and neither adapter can read the other's.
   *
   * **Values, never names, and never logged.** A resolved secret does not appear in a log line,
   * an error message, an audit row, a refusal or a run API response (invariant 21).
   */
  secretValues?: Readonly<Record<string, string>>;
}

/** What a `@harness/surface-*` package exports as `surface`. */
export interface Surface {
  /** Lowercase, stable. The client document's schema orders these and the first one is the primary. */
  name: string;
  version: string;
  /**
   * The environment variable names this adapter reads that are credentials: the host must never
   * forward one to a runtime and must never log one.
   */
  secrets: readonly string[];
  connect(deps: SurfaceDeps): Promise<SurfaceSession>;
}
