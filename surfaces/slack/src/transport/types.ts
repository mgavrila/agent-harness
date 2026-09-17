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

/**
 * The inbound half of a Slack connection. One handler for every action and one for every view:
 * the surface contract registers a single handler apiece and dispatches on the id itself.
 */
export interface SlackEvents {
  onAction(handler: (action: SlackAction) => Promise<void>): void;
  onView(handler: (view: SlackView) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackTransport {
  api: SlackApi;
  events: SlackEvents;
}
