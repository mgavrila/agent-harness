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
    auth: {
      test: async () => {
        const res = await client.auth.test();
        // Narrowed to the two ids the classifier compares against: the workspace, the app's URL
        // and the user's name are not this adapter's business at start-up.
        return { user_id: res.user_id, bot_id: res.bot_id };
      },
    },
    usergroups: {
      // Narrowed to the id, because that is all a level is decided from: a group's name and its
      // handle are an operator's words and change without the mapping changing.
      list: async () => {
        const res = await client.usergroups.list({});
        return { usergroups: (res.usergroups ?? []).flatMap((g) => (g.id ? [{ id: g.id }] : [])) };
      },
      users: {
        list: async (args) => {
          const res = await client.usergroups.users.list({ usergroup: args.usergroup });
          return { users: res.users };
        },
      },
    },
    reactions: {
      add: (args) => client.reactions.add(args),
      remove: (args) => client.reactions.remove(args),
    },
    users: {
      // Narrowed to the two name fields the directory reads, so nothing else a Slack profile
      // carries — an email, a phone number, a photo URL — travels past this boundary.
      info: async (args) => {
        const res = await client.users.info({ user: args.user });
        return {
          user: res.user
            ? {
                real_name: res.user.real_name,
                profile: { display_name: res.user.profile?.display_name, real_name: res.user.profile?.real_name },
              }
            : undefined,
        };
      },
    },
  };
}
