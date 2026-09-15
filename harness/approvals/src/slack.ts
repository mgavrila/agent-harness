import type { WebClient } from '@slack/web-api';

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
  };
  files: {
    uploadV2(args: SlackUploadArgs): Promise<{ ok?: boolean }>;
  };
  views: {
    open(args: SlackViewOpenArgs): Promise<{ ok?: boolean }>;
  };
}

/**
 * Adapt a real `WebClient`. The casts are where our narrow argument types meet
 * the SDK's much wider unions: `blocks` is `unknown[]` here because the app
 * builds Block Kit as plain objects, and `view` is a record for the same
 * reason. Nothing else is loosened.
 */
export function webClientApi(client: WebClient): SlackApi {
  return {
    chat: {
      postMessage: (args) =>
        client.chat.postMessage({
          channel: args.channel,
          text: args.text,
          blocks: args.blocks as never,
          thread_ts: args.thread_ts,
        }),
      update: (args) =>
        client.chat.update({
          channel: args.channel,
          ts: args.ts,
          text: args.text,
          blocks: args.blocks as never,
        }),
    },
    files: {
      // `FilesUploadV2Arguments` is a discriminated union on `channel_id`/`thread_ts`
      // (thread reply vs. plain upload); our optional `thread_ts` matches neither
      // branch exactly, so this cast is the same widen-at-the-boundary as `blocks`
      // and `view` above.
      uploadV2: (args) =>
        client.files.uploadV2({
          channel_id: args.channel_id,
          file: args.file,
          filename: args.filename,
          initial_comment: args.initial_comment,
          thread_ts: args.thread_ts,
        } as never),
    },
    views: {
      open: (args) => client.views.open({ trigger_id: args.trigger_id, view: args.view as never }),
    },
  };
}
