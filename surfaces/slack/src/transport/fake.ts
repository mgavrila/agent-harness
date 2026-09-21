import type {
  SlackAction,
  SlackApi,
  SlackAuthTestResult,
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
  SlackUserInfoResult,
  SlackUsergroup,
  SlackUsergroupUsersResult,
  SlackUsergroupsListResult,
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
  /** What `usergroups.list` answers. */
  usergroupsList: SlackUsergroup[] = [];
  /** Who is in each group, keyed by its id. */
  usergroupMembers: Record<string, string[]> = {};
  /** What `users.info` answers, keyed by user id. */
  userProfiles: Record<string, { real_name?: string; profile?: { display_name?: string } }> = {};
  /** How many times the group list was actually fetched, so a test can prove the cache works. */
  usergroupsListCalls = 0;
  /** What `auth.test` answers: the ids this app posts under. */
  authTest: SlackAuthTestResult = { user_id: 'U0BOTUSER', bot_id: 'B0BOTID' };
  /** How many times the identity was fetched, so a test can prove it happens once. */
  authTestCalls = 0;
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

  usergroups = {
    list: async (): Promise<SlackUsergroupsListResult> => {
      this.guard();
      this.usergroupsListCalls += 1;
      return { usergroups: this.usergroupsList };
    },
    users: {
      list: async (args: { usergroup: string }): Promise<SlackUsergroupUsersResult> => {
        this.guard();
        return { users: this.usergroupMembers[args.usergroup] ?? [] };
      },
    },
  };

  users = {
    info: async (args: { user: string }): Promise<SlackUserInfoResult> => {
      this.guard();
      return { user: this.userProfiles[args.user] };
    },
  };

  auth = {
    test: async (): Promise<SlackAuthTestResult> => {
      this.guard();
      this.authTestCalls += 1;
      return this.authTest;
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
