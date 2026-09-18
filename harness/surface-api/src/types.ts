import type { EnvSource, Logger } from '@harness/shared';

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
 * A connected surface.
 *
 * Every method that talks to the outside world rejects with a `SurfaceError` whose message is
 * safe to write into a plaintext column: it names the surface and what failed, never a path, a
 * token or a payload value.
 */
export interface SurfaceSession {
  /** This adapter's name, as `HARNESS_SURFACES` named it and as `approvals.surface` stores it. */
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  /** Where this surface posts when nobody names a conversation. */
  readonly defaultConversation: string;
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
}

/** What a `@harness/surface-*` package exports as `surface`. */
export interface Surface {
  /** Lowercase, stable. `HARNESS_SURFACES` orders these and the first one is the primary. */
  name: string;
  version: string;
  /**
   * The environment variable names this adapter reads that are credentials: the host must never
   * forward one to a runtime and must never log one.
   */
  secrets: readonly string[];
  connect(deps: SurfaceDeps): Promise<SurfaceSession>;
}
