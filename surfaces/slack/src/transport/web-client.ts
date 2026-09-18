import type { WebClient } from '@slack/web-api';
import type { SlackApi } from './types.js';

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
      postEphemeral: (args) =>
        client.chat.postEphemeral({
          channel: args.channel,
          user: args.user,
          text: args.text,
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
    conversations: {
      replies: async (args) => {
        const res = await client.conversations.replies({ channel: args.channel, ts: args.ts, limit: args.limit });
        // Narrowed to the two fields the thread rule reads, so nothing else a thread holds — the
        // messages' own text above all — travels past this boundary.
        return { messages: (res.messages ?? []).map((m) => ({ user: m.user, bot_id: m.bot_id })) };
      },
    },
  };
}
