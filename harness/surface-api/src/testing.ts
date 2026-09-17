import { SurfaceError } from '@harness/shared';
import { ANY_USER, parseAllowedUsers } from './surface.js';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageRef,
  SurfaceCapabilities,
  SurfaceSession,
  UploadRequest,
} from './types.js';

export interface MemorySurfaceOptions {
  name?: string;
  conversation?: string;
  allowedUsers?: ReadonlySet<string>;
  capabilities?: Partial<SurfaceCapabilities>;
}

/**
 * A surface that records instead of sending.
 *
 * It is two things at once and deliberately so: the whole of `@harness/surface-memory`, the
 * adapter a developer runs the host with when they have no Slack workspace, and the fake every
 * host test drives. One implementation means the thing the suite proves the host against is the
 * thing that runs. It lives under the `testing` subpath because that is where a package's fakes
 * live in this repository, and `@harness/surface-memory` is a thin wrapper that gives it a name,
 * an allowlist and a `defineSurface` declaration.
 *
 * Message ids count up from `m1`, so an assertion can rely on ordering without a clock.
 */
export class MemorySurface implements SurfaceSession {
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  readonly allowedUsers: ReadonlySet<string>;
  readonly defaultConversation: string;

  readonly cards: { ref: MessageRef; card: Card }[] = [];
  readonly texts: { conversation: string; text: string; replyTo: MessageRef | null }[] = [];
  readonly privates: { conversation: string; userId: string; text: string }[] = [];
  readonly uploads: { conversation: string; filename: string; path: string; comment: string | null }[] = [];
  readonly forms: { trigger: string; form: Form }[] = [];
  started = false;
  stopped = false;
  /** When set, every outbound call rejects with this message, the way an unreachable transport does. */
  failWith?: string;

  private seq = 0;
  private actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  private formHandler: ((event: FormEvent) => Promise<void>) | null = null;

  constructor(opts: MemorySurfaceOptions = {}) {
    this.name = opts.name ?? 'memory';
    this.defaultConversation = opts.conversation ?? 'memory';
    this.allowedUsers = opts.allowedUsers ?? parseAllowedUsers(ANY_USER);
    this.capabilities = { forms: true, privateReply: true, update: true, ...opts.capabilities };
  }

  private guard(): void {
    if (this.failWith) throw new SurfaceError(this.failWith);
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
    this.guard();
    const found = this.cards.findIndex((c) => c.ref.id === ref.id && c.ref.conversation === ref.conversation);
    if (found === -1) throw new SurfaceError(`${this.name}: no message "${ref.id}" to update`);
    this.cards[found] = { ref: this.cards[found].ref, card };
  }

  async postText(conversation: string, text: string, opts: { replyTo?: MessageRef } = {}): Promise<MessageRef> {
    this.guard();
    this.texts.push({ conversation, text, replyTo: opts.replyTo ?? null });
    return this.ref(conversation);
  }

  async postPrivate(conversation: string, userId: string, text: string): Promise<void> {
    this.guard();
    if (!this.capabilities.privateReply) throw new SurfaceError(`${this.name}: cannot send a private note`);
    this.privates.push({ conversation, userId, text });
  }

  async uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }> {
    this.guard();
    this.uploads.push({ conversation, filename: file.filename, path: file.path, comment: file.comment ?? null });
    return { filename: file.filename };
  }

  async openForm(trigger: string, form: Form): Promise<void> {
    this.guard();
    if (!this.capabilities.forms) throw new SurfaceError(`${this.name}: cannot open a form`);
    this.forms.push({ trigger, form });
  }

  onAction(handler: (event: ActionEvent) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void {
    this.formHandler = handler;
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

  /** A human submits a form. `metadata` defaults to the most recently opened form's. */
  async submit(
    formId: string,
    values: Record<string, string>,
    userId: string,
    over: Partial<FormEvent> = {},
  ): Promise<void> {
    if (!this.formHandler) throw new SurfaceError(`${this.name}: no form handler is registered`);
    const last = this.forms.at(-1) ?? null;
    await this.formHandler({
      surface: this.name,
      userId,
      conversation: this.defaultConversation,
      formId,
      metadata: last?.form.metadata ?? '',
      values,
      ...over,
    });
  }
}
