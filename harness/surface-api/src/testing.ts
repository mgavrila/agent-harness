import { SurfaceError } from '@harness/shared';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageEvent,
  MessageRef,
  PostKind,
  StreamHandle,
  SurfaceCapabilities,
  SurfaceHttp,
  SurfaceHttpRequest,
  SurfaceHttpResponse,
  SurfaceSession,
  UploadRequest,
} from './types.js';

export interface MemorySurfaceOptions {
  name?: string;
  conversation?: string;
  capabilities?: Partial<SurfaceCapabilities>;
  /**
   * The workspace every event this surface delivers belongs to, if it has one.
   *
   * A real transport reads it off the event; this one is told once, at construction, which is
   * what lets a pooled host's test route a message to the tenant whose document claims that key.
   */
  tenantHint?: string;
}

/**
 * A surface that records instead of sending.
 *
 * It is two things at once and deliberately so: the whole of `@harness/surface-memory`, the
 * adapter a developer runs the host with when they have no Slack workspace, and the fake every
 * host test drives. One implementation means the thing the suite proves the host against is the
 * thing that runs, and the first inbound surface: `say` drives a test's turn the way a real
 * message would. It lives under the `testing` subpath because that is where a package's fakes
 * live in this repository, and `@harness/surface-memory` is a thin wrapper that gives it a name
 * and a `defineSurface` declaration.
 *
 * Message ids count up from `m1`, so an assertion can rely on ordering without a clock.
 */
export class MemorySurface implements SurfaceSession {
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  readonly defaultConversation: string;
  /** What every event this surface delivers says about the workspace it came from; absent for none. */
  readonly tenantHint: string | undefined;

  readonly cards: { ref: MessageRef; card: Card }[] = [];
  readonly texts: { conversation: string; text: string; replyTo: MessageRef | null; kind: PostKind }[] = [];
  readonly privates: { conversation: string; userId: string; text: string }[] = [];
  readonly uploads: { conversation: string; filename: string; path: string; comment: string | null }[] = [];
  readonly forms: { trigger: string; form: Form }[] = [];
  readonly streams: { conversation: string; text: string; ended: boolean; replyTo: MessageRef | null }[] = [];
  /** Every request this surface's door received, in order. Empty until something mounts one. */
  readonly requests: SurfaceHttpRequest[] = [];
  /**
   * Not `readonly`, unlike the contract's own declaration: the door is mounted by a caller rather
   * than by the constructor (see `mountHttp`), and an implementation may widen a property the
   * interface declares `readonly`.
   */
  http?: SurfaceHttp;
  started = false;
  stopped = false;
  /** When set, every outbound call rejects with this message, the way an unreachable transport does. */
  failWith?: string;

  private seq = 0;
  /** The deliveries this door has acknowledged and not yet finished, so a test can await them. */
  private readonly delivering: Promise<void>[] = [];
  private actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  private formHandler: ((event: FormEvent) => Promise<void>) | null = null;
  private messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;

  constructor(opts: MemorySurfaceOptions = {}) {
    this.name = opts.name ?? 'memory';
    this.defaultConversation = opts.conversation ?? 'memory';
    this.tenantHint = opts.tenantHint;
    this.capabilities = {
      forms: true,
      privateReply: true,
      update: true,
      streaming: true,
      inlineConfirm: false,
      ...opts.capabilities,
    };
  }

  private guard(): void {
    if (this.failWith) throw new SurfaceError(this.failWith);
  }

  /** The transport check every call makes, then the capability check three of them make. */
  private requires(capable: boolean, cannot: string): void {
    this.guard();
    if (!capable) throw new SurfaceError(`${this.name}: ${cannot}`);
  }

  private ref(conversation: string): MessageRef {
    this.seq += 1;
    return { surface: this.name, conversation, id: `m${this.seq}` };
  }

  mention(userId: string): string {
    return `@${userId}`;
  }

  async postCard(conversation: string, card: Card): Promise<MessageRef> {
    this.guard();
    const ref = this.ref(conversation);
    this.cards.push({ ref, card });
    return ref;
  }

  async updateCard(ref: MessageRef, card: Card): Promise<void> {
    this.requires(this.capabilities.update, 'cannot update a message');
    const found = this.cards.findIndex(
      (c) => c.ref.id === ref.id && c.ref.conversation === ref.conversation && c.ref.surface === ref.surface,
    );
    if (found === -1) throw new SurfaceError(`${this.name}: no message "${ref.id}" to update`);
    this.cards[found] = { ref: this.cards[found].ref, card };
  }

  async postText(
    conversation: string,
    text: string,
    opts: { replyTo?: MessageRef; kind?: PostKind } = {},
  ): Promise<MessageRef> {
    this.guard();
    this.texts.push({ conversation, text, replyTo: opts.replyTo ?? null, kind: opts.kind ?? 'reply' });
    return this.ref(conversation);
  }

  async postPrivate(conversation: string, userId: string, text: string): Promise<void> {
    this.requires(this.capabilities.privateReply, 'cannot send a private note');
    this.privates.push({ conversation, userId, text });
  }

  async uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }> {
    this.guard();
    this.uploads.push({ conversation, filename: file.filename, path: file.path, comment: file.comment ?? null });
    return { filename: file.filename };
  }

  async openForm(trigger: string, form: Form): Promise<void> {
    this.requires(this.capabilities.forms, 'cannot open a form');
    this.forms.push({ trigger, form });
  }

  onAction(handler: (event: ActionEvent) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void {
    this.formHandler = handler;
  }

  onMessage(handler: (event: MessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  startStream(conversation: string, opts: { replyTo?: MessageRef; recipient?: string } = {}): StreamHandle {
    this.requires(this.capabilities.streaming, 'cannot stream a reply');
    const entry = { conversation, text: '', ended: false, replyTo: opts.replyTo ?? null };
    this.streams.push(entry);
    return {
      append: (delta) => {
        entry.text += delta;
      },
      end: async () => {
        entry.ended = true;
        return this.postText(conversation, entry.text, { replyTo: opts.replyTo });
      },
    };
  }

  /**
   * A human writes to the assistant. Mentioned by default, in the default conversation, with no
   * attachments; `over` overrides any field. This is how every host test starts a turn.
   */
  async say(userId: string, text: string, over: Partial<MessageEvent> = {}): Promise<void> {
    if (!this.messageHandler) throw new SurfaceError(`${this.name}: no message handler is registered`);
    await this.messageHandler({
      surface: this.name,
      userId,
      conversation: this.defaultConversation,
      text,
      attachments: [],
      message: null,
      mentioned: true,
      // Before `over`, so a test that wants an event from somebody else's workspace — which is
      // what a host's refusal is proved with — can still name one.
      ...(this.tenantHint === undefined ? {} : { tenantHint: this.tenantHint }),
      ...over,
    });
  }

  /**
   * Mount this surface's inbound door at `path`.
   *
   * **Off until it is called**, and `@harness/surface-memory` never calls it. This surface accepts
   * any user id with no authentication at all — that is what it is for — so a door to it is a way
   * to speak as anybody, and a developer's host should not grow one merely because its document
   * declared the memory surface. A host test mounts it on the session the pool opened: it is the
   * reference implementation of the `http` seam and the thing the host's dispatch is proved
   * against.
   */
  mountHttp(path = 'messages'): void {
    this.http = { path, handle: (request) => this.handleHttp(request) };
  }

  /**
   * Wait for every delivery this door has acknowledged.
   *
   * The door answers before the message is delivered, exactly as a real transport must, so a test
   * that asserted straight after the response would race the handler it is testing.
   */
  async settled(): Promise<void> {
    await Promise.all(this.delivering);
  }

  private async handleHttp(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> {
    this.requests.push(request);
    if (request.method !== 'POST') return { status: 405, refusal: { reason: 'method_not_allowed' } };
    const message = parseMemoryMessage(request.body);
    // The refusal names the kind and nothing else: the body is not repeated, not summarised and
    // not logged, because a refused request is one nobody has authenticated.
    if (!message) return { status: 400, refusal: { reason: 'bad_request' } };
    // Acknowledge, then run. `say` rejects when no handler is registered, which is a race at
    // startup rather than a fault in the request, so it is swallowed here and the sender is told
    // the door took the message.
    this.delivering.push(this.say(message.userId, message.text).catch(() => undefined));
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /**
   * A human presses a button. The event names the most recently posted card, which is what a
   * test almost always means; `over` overrides any field for the case where it is not.
   */
  async press(actionId: string, value: string, userId: string, over: Partial<ActionEvent> = {}): Promise<void> {
    if (!this.actionHandler) throw new SurfaceError(`${this.name}: no action handler is registered`);
    const last = this.cards.at(-1) ?? null;
    await this.actionHandler({
      surface: this.name,
      userId,
      conversation: last?.ref.conversation ?? this.defaultConversation,
      message: last?.ref ?? null,
      actionId,
      value,
      trigger: 'memory-trigger',
      ...over,
    });
  }

  /**
   * A human submits a form. `metadata` defaults to the most recently opened form's, and the
   * conversation to the most recently posted card's — a form is opened from a button on a card,
   * so that is the conversation the submission belongs to. `over` overrides either.
   */
  async submit(
    formId: string,
    values: Record<string, string>,
    userId: string,
    over: Partial<FormEvent> = {},
  ): Promise<void> {
    if (!this.formHandler) throw new SurfaceError(`${this.name}: no form handler is registered`);
    const last = this.forms.at(-1) ?? null;
    const lastCard = this.cards.at(-1) ?? null;
    await this.formHandler({
      surface: this.name,
      userId,
      conversation: lastCard?.ref.conversation ?? this.defaultConversation,
      formId,
      metadata: last?.form.metadata ?? '',
      values,
      ...over,
    });
  }
}

/** `{ userId, text }`, or null for anything else. Deliberately not a zod schema: it is two strings. */
function parseMemoryMessage(body: string): { userId: string; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const { userId, text } = (parsed ?? {}) as { userId?: unknown; text?: unknown };
  if (typeof userId !== 'string' || userId === '' || typeof text !== 'string' || text === '') return null;
  return { userId, text };
}
