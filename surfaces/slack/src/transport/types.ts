export interface SlackPostMessageArgs {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}

export interface SlackUpdateArgs {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackUploadArgs {
  channel_id: string;
  file: Buffer;
  filename: string;
  initial_comment?: string;
  thread_ts?: string;
}

export interface SlackViewOpenArgs {
  trigger_id: string;
  view: Record<string, unknown>;
}

export interface SlackEphemeralArgs {
  channel: string;
  user: string;
  text: string;
}

export interface SlackRepliesArgs {
  channel: string;
  /** The thread's parent message, Slack's `thread_ts`. */
  ts: string;
  limit?: number;
}

/** The two fields of a threaded message that say whether the assistant wrote it. */
export interface SlackThreadMessage {
  user?: string;
  bot_id?: string;
}

export interface SlackRepliesResult {
  messages?: SlackThreadMessage[];
}

export interface SlackPostResult {
  ok?: boolean;
  ts?: string;
  channel?: string;
}

/**
 * The slice of Slack's Web API this app uses. Declaring it ourselves keeps the
 * tests free of a Slack client: `FakeSlack` implements this and nothing else,
 * and `webClientApi` adapts the real `WebClient` onto it.
 */
export interface SlackApi {
  chat: {
    postMessage(args: SlackPostMessageArgs): Promise<SlackPostResult>;
    update(args: SlackUpdateArgs): Promise<SlackPostResult>;
    postEphemeral(args: SlackEphemeralArgs): Promise<SlackPostResult>;
  };
  files: {
    uploadV2(args: SlackUploadArgs): Promise<{ ok?: boolean }>;
  };
  views: {
    open(args: SlackViewOpenArgs): Promise<{ ok?: boolean }>;
  };
  conversations: {
    replies(args: SlackRepliesArgs): Promise<SlackRepliesResult>;
  };
}

/**
 * One block action, narrowed off Bolt's payload. Everything Bolt-specific is in `bolt.ts`, so
 * the session and its tests never touch a Bolt type — the same seam the approvals app already
 * had, moved into the adapter that owns it.
 */
export interface SlackAction {
  userId: string;
  channel: string;
  actionId: string;
  value: string;
  triggerId: string | null;
  /** The timestamp of the message the button was on, when Slack sends one. */
  messageTs: string | null;
}

export interface SlackView {
  userId: string;
  callbackId: string;
  privateMetadata: string;
  /** Slack's `view.state.values`, field block id → element action id → value. */
  state: Record<string, Record<string, { value?: string | null }>>;
}

/** One inbound message, narrowed off Bolt's payload. `files` is already downloaded. */
export interface SlackInbound {
  userId: string;
  channel: string;
  text: string;
  ts: string;
  threadTs: string | null;
  /**
   * True for a direct message, for a message that mentions the bot, and for a reply inside a
   * thread the assistant has already posted in.
   */
  mentioned: boolean;
  /** `path` is relative to `<storageDir>/incoming`. */
  files: { name: string; path: string }[];
}

/** The fields of a Bolt `message` or `app_mention` payload the classifier reads. */
export interface RawMessage {
  type: 'message' | 'app_mention';
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: { name?: string; url_private_download?: string }[];
}

/**
 * The inbound half of a Slack connection. One handler for every action, one for every view, and
 * one for every message: the surface contract registers a single handler apiece and dispatches
 * on the id itself.
 */
export interface SlackEvents {
  onAction(handler: (action: SlackAction) => Promise<void>): void;
  onView(handler: (view: SlackView) => Promise<void>): void;
  onMessage(handler: (message: SlackInbound) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackTransport {
  api: SlackApi;
  events: SlackEvents;
  /**
   * Record that the assistant has posted in the thread `messageId` belongs to. The session calls
   * this wherever a turn replies inside a thread, and the transport counts a later reply there as
   * addressed to the assistant even when nobody mentions it. `messageId` is the message being
   * answered, which inside an existing thread is not that thread's root; resolving the two is the
   * transport's job, since it is what saw the message arrive.
   */
  notePostedIn(channel: string, messageId: string): void;
}
