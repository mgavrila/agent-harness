import { readFile } from 'node:fs/promises';
import { SurfaceAcceptedError, SurfaceError, type Logger } from '@harness/shared';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageRef,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { slackDirectory } from './directory.js';
import { toMrkdwn } from './format.js';
import { guarded, NAME } from './guarded.js';
import { cardBlocks } from './render/blocks.js';
import { formView, valuesOf } from './render/modal.js';
import { createEditStream } from './stream.js';
import type { SlackTransport } from './transport/types.js';

/**
 * A Slack channel, group or direct-message id.
 *
 * The kernel validates a conversation id only as a shape, because it cannot know a surface's
 * format; this is where the real check happens, at dispatch, and a bad id fails that one effect
 * with a message an operator reads through `harness_reconcile`.
 */
const SLACK_CONVERSATION = /^[CGD][A-Z0-9]{2,}$/;

/**
 * The rejected id is deliberately *not* in the message. It is an agent-chosen argument, the
 * kernel admits any conversation-shaped string, and this message is written verbatim into
 * `tool_effects.last_error`, which is plaintext — so an id that spelled an SSN or an EIN would
 * land there. The length is enough for an operator to see which argument was wrong; the value
 * itself is in the encrypted payload, where `harness_reconcile` reads it.
 */
function assertConversation(conversation: string): void {
  if (!SLACK_CONVERSATION.test(conversation)) {
    throw new SurfaceError(`${NAME}: that is not a Slack conversation id (${conversation.length} characters)`);
  }
}

/**
 * A direct message's id. Slack's channel ids begin `C` for a channel, `G` for a private group and
 * `D` for a direct message, which `SLACK_CONVERSATION` above already spells out.
 */
const DIRECT_MESSAGE_PREFIX = 'D';

/**
 * What the assistant marks a message with while it is working on an answer.
 *
 * `eyes` rather than an hourglass: it reads as "seen", which is the true claim at the moment it
 * goes on — the turn has started and nothing has been decided yet.
 */
export const ACK_REACTION = 'eyes';

export function createSlackSession(transport: SlackTransport, config: SlackConfig, log: Logger): SurfaceSession {
  const { api, events } = transport;

  const ref = (conversation: string, id: string): MessageRef => ({ surface: NAME, conversation, id });

  /**
   * The thread a reply belongs in, or undefined for one that belongs in no thread.
   *
   * Two rules, both of them Slack's rather than the kernel's, which is why they are here and not
   * in `harness/host/src`:
   *
   * **A direct message has no thread.** It is already one person's conversation, and threading
   * every answer inside it buries the conversation under one-reply threads. The host cannot make
   * this call: it would have to know what a `D` prefix means, and `kernel-vocabulary.test.ts`
   * exists to stop it learning.
   *
   * **A reply names its thread's root, not the message it answers.** The host hands over the
   * triggering message, which inside an existing thread is a reply's own timestamp — and Slack
   * documents that as the wrong handle for `thread_ts`. The transport saw the message arrive and
   * remembered which thread it was in, so it is the one that can say.
   */
  const threadFor = (conversation: string, replyTo: MessageRef | undefined): string | undefined => {
    if (!replyTo) return undefined;
    if (conversation.startsWith(DIRECT_MESSAGE_PREFIX)) return undefined;
    return transport.rootOf(conversation, replyTo.id);
  };

  return {
    name: NAME,
    capabilities: { forms: true, privateReply: true, update: true, streaming: true, inlineConfirm: false },
    defaultConversation: config.defaultConversation,
    // Built once per session and cached inside, so this tenant's identity plug-in shares one set
    // of workspace requests across every caller that asks.
    directory: slackDirectory(api, { now: () => new Date() }),
    // The host mounts this and hands over what arrives; the transport verifies it. Spread rather
    // than assigned, because a session over the fake transport has no door and the contract's
    // `http` is optional rather than nullable.
    ...(transport.http ? { http: transport.http } : {}),

    mention: (userId) => `<@${userId}>`,

    /**
     * Mark the message being answered, and answer with the way to unmark it.
     *
     * Nothing to react to is nothing to do: a reaction goes on a message, and a conversation is
     * not one. Neither call can fail the turn — the host wraps both — but the disposer is made
     * forgiving here as well, because a reaction that cannot be taken down is a smaller wrong than
     * one that takes a finished turn with it, and the host would only find out by stopping.
     */
    async typing(conversation, opts = {}) {
      assertConversation(conversation);
      const message = opts.replyTo;
      if (!message) return async () => {};
      await guarded('reactions.add', () =>
        api.reactions.add({ channel: conversation, timestamp: message.id, name: ACK_REACTION }),
      );
      return async () => {
        try {
          await api.reactions.remove({ channel: conversation, timestamp: message.id, name: ACK_REACTION });
        } catch (err) {
          // One fixed sentence, and the Slack error beside it where a logger shows one. The
          // reaction stays; a person sees an assistant that is still looking, which is wrong and
          // harmless, and the alternative is worse.
          log.warn('a Slack reaction could not be removed', err);
        }
      };
    },

    async postCard(conversation, card: Card) {
      assertConversation(conversation);
      const res = await guarded('chat.postMessage', () =>
        api.chat.postMessage({ channel: conversation, text: card.notice, blocks: cardBlocks(card) }),
      );
      // Slack answered, so the card is in the channel even though this call cannot say where.
      // `SurfaceAcceptedError`, not a plain one: the host must keep whatever claim it holds and
      // let its stale sweep decide, rather than post a second card with a second live set of
      // buttons on the next tick.
      if (!res.ts) throw new SurfaceAcceptedError(`${NAME}: the card was accepted without a timestamp`);
      return ref(conversation, res.ts);
    },

    async updateCard(message, card: Card) {
      assertConversation(message.conversation);
      await guarded('chat.update', () =>
        api.chat.update({
          channel: message.conversation,
          ts: message.id,
          text: card.notice,
          blocks: cardBlocks(card),
        }),
      );
    },

    async postText(conversation, text, opts = {}) {
      assertConversation(conversation);
      const res = await guarded('chat.postMessage', () =>
        api.chat.postMessage({
          channel: conversation,
          text: toMrkdwn(text),
          thread_ts: threadFor(conversation, opts.replyTo),
        }),
      );
      // The assistant has now spoken in that thread, so a later reply there is addressed to it
      // with no mention. The id names the message being answered rather than the thread's root;
      // the transport resolves one to the other. A notice is the host talking about a message it
      // will not answer, and a thread it claimed would turn one refusal into every refusal.
      if (opts.replyTo && opts.kind !== 'notice') transport.notePostedIn(conversation, opts.replyTo.id);
      // A text reply is never written to a row and nothing sweeps it, so an accepted post
      // without a timestamp is still a success: an empty id here only means "no reference".
      // Raising would make the outbox retry an already-delivered message.
      return ref(conversation, res.ts ?? '');
    },

    async postPrivate(conversation, userId, text) {
      assertConversation(conversation);
      await guarded('chat.postEphemeral', () => api.chat.postEphemeral({ channel: conversation, user: userId, text }));
    },

    async uploadFile(conversation, file: UploadRequest) {
      assertConversation(conversation);
      let bytes: Buffer;
      try {
        bytes = await readFile(file.path);
      } catch {
        // Node's fs error carries the absolute path and this message is written into
        // `tool_effects.last_error`, which is plaintext.
        throw new SurfaceError(`${NAME}: the staged file could not be read`);
      }
      await guarded('files.uploadV2', () =>
        api.files.uploadV2({
          channel_id: conversation,
          file: bytes,
          filename: file.filename,
          initial_comment: file.comment,
          thread_ts: threadFor(conversation, file.replyTo),
        }),
      );
      return { filename: file.filename };
    },

    async openForm(trigger, form: Form) {
      await guarded('views.open', () => api.views.open({ trigger_id: trigger, view: formView(form) }));
    },

    onAction(handler: (event: ActionEvent) => Promise<void>) {
      events.onAction(async (action) => {
        await handler({
          surface: NAME,
          userId: action.userId,
          conversation: action.channel,
          message: action.messageTs === null ? null : ref(action.channel, action.messageTs),
          actionId: action.actionId,
          value: action.value,
          trigger: action.triggerId,
        });
      });
    },

    // Deliberately no state between opening a form and reading its submission back. Slack's
    // `view_submission` carries the answers under the block ids this adapter wrote, so `valuesOf`
    // reads them out of the payload; a `Map` of open forms would lose a modal opened before a
    // restart.
    onFormSubmit(handler: (event: FormEvent) => Promise<void>) {
      events.onView(async (view) => {
        await handler({
          surface: NAME,
          userId: view.userId,
          // Slack's view submission carries no conversation of its own for a modal opened from
          // a button, which is why the host travels one inside the metadata it gets back.
          conversation: '',
          formId: view.callbackId,
          metadata: view.privateMetadata,
          values: valuesOf(view.state),
        });
      });
    },

    onMessage(handler) {
      events.onMessage(async (message) => {
        await handler({
          surface: NAME,
          userId: message.userId,
          conversation: message.channel,
          text: message.text,
          // Already downloaded into <storageDir>/incoming by the transport.
          attachments: message.files.map((f) => ({ name: f.name, path: f.path })),
          message: ref(message.channel, message.ts),
          mentioned: message.mentioned,
          // The workspace, for the host to route on. Omitted rather than sent as null when the
          // transport could not name one: the contract's field is optional, and a hint of "none"
          // is what a surface with no notion of a workspace reports.
          ...(message.teamId === null ? {} : { tenantHint: message.teamId }),
        });
      });
    },

    startStream(conversation, opts = {}) {
      assertConversation(conversation);
      // Noted when the stream opens rather than when its first delta lands: this is the moment
      // the thread becomes a conversation with the assistant, and a stream that ends up posting
      // nothing leaves behind one key that costs nothing.
      if (opts.replyTo) transport.notePostedIn(conversation, opts.replyTo.id);
      return createEditStream({ api, conversation, threadTs: threadFor(conversation, opts.replyTo) });
    },

    start: () => events.start(),
    stop: () => events.stop(),

    /**
     * Whether this workspace has been reached, from what the transport already knows.
     *
     * Synchronous, and never an `auth.test` of its own: the host asks its surfaces this on every
     * `GET /v1/status`, and a poll that called Slack once per tenant per tick is a rate limit
     * nobody chose. `start()` is what asks, at tenant open; a `start()` that was refused reports
     * false here until the next delivery asks again, because the retry belongs on the delivery
     * path and not in a status route. The two sentences are fixed and written here; Slack's own
     * `error` string (`invalid_auth`, `account_inactive`) never travels.
     */
    health: () => {
      const state = transport.identityState();
      if (state === 'confirmed') return { live: true };
      return {
        live: false,
        detail:
          state === 'refused' ? 'the Slack workspace refused this app' : 'the Slack workspace has not been reached yet',
      };
    },
  };
}
