import type {
  SlackAction,
  SlackApi,
  SlackEphemeralArgs,
  SlackEvents,
  SlackInbound,
  SlackPostMessageArgs,
  SlackPostResult,
  SlackRepliesArgs,
  SlackRepliesResult,
  SlackThreadMessage,
  SlackUpdateArgs,
  SlackUploadArgs,
  SlackView,
  SlackViewOpenArgs,
} from './types.js';

/**
 * A Slack that records instead of sending. Timestamps count up from a fixed
 * base so assertions can rely on ordering without matching a real clock.
 */
export class FakeSlack implements SlackApi {
  posts: SlackPostMessageArgs[] = [];
  updates: SlackUpdateArgs[] = [];
  uploads: SlackUploadArgs[] = [];
  opened: SlackViewOpenArgs[] = [];
  ephemeral: SlackEphemeralArgs[] = [];
  /** Every `conversations.replies` call that got past `failWith`, in order. */
  repliesCalls: SlackRepliesArgs[] = [];
  /** What `conversations.replies` answers, keyed `<channel>:<thread ts>`; missing is an empty thread. */
  replies: Record<string, SlackThreadMessage[]> = {};
  /** When set, every call rejects with this message. */
  failWith?: string;
  /**
   * When set, `chat.postMessage` records the message and answers `ok` with no `ts`, which Slack's
   * own response type allows. The message is sent; there is just nothing to address it by later.
   */
  acceptWithoutTs = false;

  private seq = 0;

  private nextTs(): string {
    this.seq += 1;
    return `1789000000.${String(this.seq).padStart(6, '0')}`;
  }

  private guard(): void {
    if (this.failWith) throw new Error(this.failWith);
  }

  chat = {
    postMessage: async (args: SlackPostMessageArgs): Promise<SlackPostResult> => {
      this.guard();
      this.posts.push(args);
      if (this.acceptWithoutTs) return { ok: true, channel: args.channel };
      return { ok: true, ts: this.nextTs(), channel: args.channel };
    },
    update: async (args: SlackUpdateArgs): Promise<SlackPostResult> => {
      this.guard();
      this.updates.push(args);
      return { ok: true, ts: args.ts, channel: args.channel };
    },
    postEphemeral: async (args: SlackEphemeralArgs): Promise<SlackPostResult> => {
      this.guard();
      this.ephemeral.push(args);
      return { ok: true, channel: args.channel };
    },
  };

  files = {
    uploadV2: async (args: SlackUploadArgs): Promise<{ ok?: boolean }> => {
      this.guard();
      this.uploads.push(args);
      return { ok: true };
    },
  };

  views = {
    open: async (args: SlackViewOpenArgs): Promise<{ ok?: boolean }> => {
      this.guard();
      this.opened.push(args);
      return { ok: true };
    },
  };

  conversations = {
    replies: async (args: SlackRepliesArgs): Promise<SlackRepliesResult> => {
      this.guard();
      this.repliesCalls.push(args);
      return { messages: this.replies[`${args.channel}:${args.ts}`] ?? [] };
    },
  };
}

/** The inbound half of `FakeSlack`: a test calls `emitAction` where Slack would. */
export class FakeSlackEvents implements SlackEvents {
  started = false;
  stopped = false;
  private actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  private viewHandler: ((view: SlackView) => Promise<void>) | null = null;
  private messageHandler: ((message: SlackInbound) => Promise<void>) | null = null;

  onAction(handler: (action: SlackAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onView(handler: (view: SlackView) => Promise<void>): void {
    this.viewHandler = handler;
  }

  onMessage(handler: (message: SlackInbound) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async emitAction(action: SlackAction): Promise<void> {
    if (!this.actionHandler) throw new Error('no action handler is registered');
    await this.actionHandler(action);
  }

  async emitView(view: SlackView): Promise<void> {
    if (!this.viewHandler) throw new Error('no view handler is registered');
    await this.viewHandler(view);
  }

  async emitMessage(message: SlackInbound): Promise<void> {
    if (!this.messageHandler) throw new Error('no message handler is registered');
    await this.messageHandler(message);
  }
}
