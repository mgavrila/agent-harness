import { readFile } from 'node:fs/promises';
import { describeError, SurfaceAcceptedError, SurfaceError } from '@harness/shared';
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
import { cardBlocks } from './render/blocks.js';
import { formView, valuesOf } from './render/modal.js';
import type { SlackTransport } from './transport/types.js';

const NAME = 'slack';

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
 * Run one Web API call and turn whatever it throws into a `SurfaceError`.
 *
 * Every method on the contract promises a `SurfaceError` whose message is safe to write into
 * `tool_effects.last_error`, which is plaintext and which an operator pastes into a ticket. The
 * SDK's own rejection is not that: it is a `WebAPIPlatformError` the kernel would mask, and an
 * unwrapped network failure carries a stack. So the message is the surface, the operation, and
 * the underlying message — `op` is the API method's name and never the arguments, so no card
 * text, no note, no filename and no channel can travel in it.
 */
async function guarded<T>(op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new SurfaceError(`${NAME}: ${op} failed: ${describeError(err)}`);
  }
}

export function createSlackSession(transport: SlackTransport, config: SlackConfig): SurfaceSession {
  const { api, events } = transport;

  const ref = (conversation: string, id: string): MessageRef => ({ surface: NAME, conversation, id });

  return {
    name: NAME,
    capabilities: { forms: true, privateReply: true, update: true, streaming: false, inlineConfirm: false },
    defaultConversation: config.defaultConversation,

    mention: (userId) => `<@${userId}>`,

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
        api.chat.postMessage({ channel: conversation, text, thread_ts: opts.replyTo?.id }),
      );
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
          thread_ts: file.replyTo?.id,
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
        });
      });
    },

    startStream() {
      throw new SurfaceError(`${NAME}: cannot stream a reply`);
    },

    start: () => events.start(),
    stop: () => events.stop(),
  };
}
