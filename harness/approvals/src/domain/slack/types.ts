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
