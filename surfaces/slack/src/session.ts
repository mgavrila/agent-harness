import { readFile } from 'node:fs/promises';
import { SurfaceError } from '@harness/shared';
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

function assertConversation(conversation: string): void {
  if (!SLACK_CONVERSATION.test(conversation)) {
    throw new SurfaceError(`${NAME}: "${conversation}" is not a Slack conversation id`);
  }
}

export function createSlackSession(transport: SlackTransport, config: SlackConfig): SurfaceSession {
  const { api, events } = transport;

  // Deliberately no state between opening a form and reading its submission back. Slack's
  // `view_submission` carries the answers under the block ids this adapter wrote, so `valuesOf`
  // reads them out of the payload; a `Map` of open forms would lose a modal opened before a
  // restart, which today's `main.ts` never does.
  const ref = (conversation: string, id: string): MessageRef => ({ surface: NAME, conversation, id });

  return {
    name: NAME,
    capabilities: { forms: true, privateReply: true, update: true },
    allowedUsers: config.allowedUsers,
    defaultConversation: config.defaultConversation,

    mention: (userId) => `<@${userId}>`,

    async postCard(conversation, card: Card) {
      assertConversation(conversation);
      const res = await api.chat.postMessage({
        channel: conversation,
        text: card.notice,
        blocks: cardBlocks(card),
      });
      if (!res.ts) throw new SurfaceError(`${NAME}: the message was accepted without a timestamp`);
      return ref(conversation, res.ts);
    },

    async updateCard(message, card: Card) {
      assertConversation(message.conversation);
      await api.chat.update({
        channel: message.conversation,
        ts: message.id,
        text: card.notice,
        blocks: cardBlocks(card),
      });
    },

    async postText(conversation, text, opts = {}) {
      assertConversation(conversation);
      const res = await api.chat.postMessage({ channel: conversation, text, thread_ts: opts.replyTo?.id });
      if (!res.ts) throw new SurfaceError(`${NAME}: the message was accepted without a timestamp`);
      return ref(conversation, res.ts);
    },

    async postPrivate(conversation, userId, text) {
      assertConversation(conversation);
      await api.chat.postEphemeral({ channel: conversation, user: userId, text });
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
      await api.files.uploadV2({
        channel_id: conversation,
        file: bytes,
        filename: file.filename,
        initial_comment: file.comment,
        thread_ts: file.replyTo?.id,
      });
      return { filename: file.filename };
    },

    async openForm(trigger, form: Form) {
      await api.views.open({ trigger_id: trigger, view: formView(form) });
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

    start: () => events.start(),
    stop: () => events.stop(),
  };
}
