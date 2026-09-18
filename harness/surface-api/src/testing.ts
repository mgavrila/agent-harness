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
  SurfaceSession,
  UploadRequest,
} from './types.js';

export interface MemorySurfaceOptions {
  name?: string;
  conversation?: string;
  capabilities?: Partial<SurfaceCapabilities>;
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

  readonly cards: { ref: MessageRef; card: Card }[] = [];
  readonly texts: { conversation: string; text: string; replyTo: MessageRef | null; kind: PostKind }[] = [];
  readonly privates: { conversation: string; userId: string; text: string }[] = [];
  readonly uploads: { conversation: string; filename: string; path: string; comment: string | null }[] = [];
  readonly forms: { trigger: string; form: Form }[] = [];
  readonly streams: { conversation: string; text: string; ended: boolean; replyTo: MessageRef | null }[] = [];
  started = false;
  stopped = false;
  /** When set, every outbound call rejects with this message, the way an unreachable transport does. */
  failWith?: string;

  private seq = 0;
  private actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  private formHandler: ((event: FormEvent) => Promise<void>) | null = null;
  private messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;

  constructor(opts: MemorySurfaceOptions = {}) {
    this.name = opts.name ?? 'memory';
    this.defaultConversation = opts.conversation ?? 'memory';
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
      ...over,
    });
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
