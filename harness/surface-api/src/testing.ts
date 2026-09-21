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
  SurfaceHealth,
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

/** Where this door's event stream lives, below whatever path `mountHttp` was given. */
export const MEMORY_EVENTS_SUBPATH = 'events';

/**
 * How many frames this door keeps for a client that reconnects with `last-event-id`.
 *
 * A reference implementation's window, not a product's: fifty frames is enough for a test to
 * prove that a resume repeats nothing and that a resume past the window starts from what is left,
 * which are the two behaviours the seam has to make possible. What a real adapter's window should
 * be is spec section 13.5.
 */
export const MEMORY_FRAME_RETENTION = 50;

/** One frame this door has sent, and can send again to a client that resumes. */
export interface MemoryFrame {
  id: number;
  event: string;
  data: unknown;
}

/** The wire form of a frame: the whole Server-Sent Events format, which is three lines. */
function frameText(frame: MemoryFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
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
  /** Every frame this door has emitted, oldest first, capped at `MEMORY_FRAME_RETENTION`. */
  readonly frames: MemoryFrame[] = [];
  /** How many event streams this door has open. A test asserts it falls back to zero. */
  openStreams = 0;

  private frameSeq = 0;
  /** The streams parked waiting for something to happen, so `emit` can wake them. */
  private readonly waiting = new Set<() => void>();
  /** Set by `breakStreams`: the first open stream to pull throws this and clears it. */
  private streamFailure: string | null = null;
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
  /**
   * The deliveries this door has acknowledged and not yet finished, so a test can await them.
   *
   * Each one removes itself once it settles, so a long suite driving one surface holds the
   * handful still in flight rather than every message it has ever sent.
   */
  private readonly delivering = new Set<Promise<void>>();
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

  /**
   * Push one frame to every open stream, and remember it for a client that resumes.
   *
   * This is the door's outbound half. A real adapter emits a frame from its own `postText`,
   * `postCard` and stream handle; this one is driven by a test, because what the seam has to prove
   * is that a chunk reaches the socket when it is produced and not when the handler returns.
   */
  emit(event: string, data: unknown): void {
    this.frameSeq += 1;
    this.frames.push({ id: this.frameSeq, event, data });
    if (this.frames.length > MEMORY_FRAME_RETENTION) this.frames.shift();
    this.wake();
  }

  /**
   * Make the next pull of an open stream throw, the way a producer that failed does.
   *
   * **One stream, not every one**: the first to observe the failure clears it, so with two open
   * the second carries on. That is enough for what this exists to drive — the host's side of a
   * throw mid-stream, which is logged and closes the response, with no frame for it — and a door
   * that failed every stream at once would be inventing a fan-out a real adapter does not have.
   */
  breakStreams(message: string): void {
    this.streamFailure = message;
    this.wake();
  }

  private wake(): void {
    // A copy, because a waiter removes itself from the set as it runs.
    for (const waiter of [...this.waiting]) waiter();
  }

  /**
   * Park until something happens: a frame, a failure, or the caller going away.
   *
   * The abort listener is removed on every path, so a long-lived signal does not accumulate one
   * listener per frame.
   */
  private async pause(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiting.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiting.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The frames after `last-event-id`, then whatever is emitted, until the caller goes away.
   *
   * A resume the window no longer covers starts from the oldest frame still held rather than
   * failing: the client asked to carry on, and the honest answer is "here is where I can carry on
   * from". Telling the client that frames were dropped is a vocabulary question and belongs to an
   * adapter that has one.
   */
  private async *eventStream(request: SurfaceHttpRequest): AsyncGenerator<string> {
    const asked = Number.parseInt(request.headers['last-event-id'] ?? '', 10);
    let sent = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
    this.openStreams += 1;
    try {
      for (;;) {
        const failure = this.streamFailure;
        if (failure !== null) {
          this.streamFailure = null;
          throw new Error(failure);
        }
        const next = this.frames.filter((frame) => frame.id > sent);
        if (next.length > 0) {
          for (const frame of next) {
            sent = frame.id;
            yield frameText(frame);
          }
          continue;
        }
        // The signal is checked **after** the backlog, not before it: a caller that has already
        // hung up still gets what the door was holding, and then the stream ends. Testing it
        // first would make an already-aborted request answer nothing at all, which is the one
        // shape of this call that has to terminate for a collector to be usable on it.
        if (request.signal.aborted) return;
        await this.pause(request.signal);
      }
    } finally {
      // `finally`, so an abort, a throw and a consumer that simply stops pulling all close it.
      this.openStreams -= 1;
    }
  }

  private async handleHttp(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> {
    this.requests.push(request);
    if (request.path === MEMORY_EVENTS_SUBPATH) {
      if (request.method !== 'GET') return { status: 405, headers: { allow: 'GET' } };
      return {
        status: 200,
        // The three headers that stop something in between buffering a stream into one response.
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        body: this.eventStream(request),
      };
    }
    if (request.method !== 'POST') return { status: 405, refusal: { reason: 'method_not_allowed' } };
    const message = parseMemoryMessage(request.body);
    // The refusal names the kind and nothing else: the body is not repeated, not summarised and
    // not logged, because a refused request is one nobody has authenticated.
    if (!message) return { status: 400, refusal: { reason: 'bad_request' } };
    // Acknowledge, then run. `say` rejects when no handler is registered, which is a race at
    // startup rather than a fault in the request, so it is swallowed here and the sender is told
    // the door took the message.
    const delivery = this.say(message.userId, message.text).catch(() => undefined);
    this.delivering.add(delivery);
    void delivery.finally(() => this.delivering.delete(delivery));
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /**
   * What this door already knows about itself, which is the two flags above. Synchronous and
   * reaching nothing, exactly as the contract says an adapter's must be, so a host test can drive
   * the whole shape of `GET /v1/status` without a transport.
   */
  health(): SurfaceHealth {
    return this.started && !this.stopped ? { live: true } : { live: false, detail: 'this door is not open' };
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

/**
 * A response body as text, whichever shape it is.
 *
 * A string comes back as itself; a stream is drained and joined. **Only call it on a stream that
 * ends** — an aborted request, or a producer that finishes — because a live event stream has no
 * end and this would wait for one. A test that wants to read a live stream pulls its iterator
 * frame by frame instead.
 */
export async function bodyText(response: SurfaceHttpResponse): Promise<string> {
  const body = response.body;
  if (body === undefined) return '';
  if (typeof body === 'string') return body;
  let text = '';
  for await (const chunk of body) text += chunk;
  return text;
}
