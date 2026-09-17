import { App, LogLevel } from '@slack/bolt';
import type { Logger } from '@harness/shared';
import type { SlackConfig } from '../config.js';
import { downloadAttachments, type SlackFile } from './files.js';
import type { RawMessage, SlackAction, SlackEvents, SlackInbound, SlackTransport, SlackView } from './types.js';
import { webClientApi } from './web-client.js';

/**
 * What an inbound payload means, or null to drop it (decision 1 of Plan 8b).
 *
 * `app_mention` is the one event that says the assistant was addressed in a channel; a channel
 * `message` that carries the mention is the same message arriving a second time (when the bot is a
 * member) and is dropped. A direct message is addressed by construction and is kept even when it
 * names the bot, with the token stripped. Bots, edits, deletions and joins are not messages from a
 * person; a `file_share` is.
 */
export function classifyMessage(
  event: RawMessage,
  botUserId: string | undefined,
): { userId: string; text: string; mentioned: boolean; files: SlackFile[] } | null {
  if (event.bot_id || !event.user) return null;
  const mention = botUserId ? `<@${botUserId}>` : null;
  const text = event.text ?? '';
  const files = (event.files ?? [])
    .filter(
      (f): f is { name: string; url_private_download: string } =>
        typeof f.name === 'string' && typeof f.url_private_download === 'string',
    )
    .map((f) => ({ name: f.name, url: f.url_private_download }));
  if (event.type === 'app_mention') {
    return {
      userId: event.user,
      text: mention ? text.replaceAll(mention, '').trim() : text.trim(),
      mentioned: true,
      files,
    };
  }
  if (event.subtype !== undefined && event.subtype !== 'file_share') return null;
  const direct = event.channel_type === 'im';
  // In a channel the same message arrives twice when the bot is a member, once as `app_mention`;
  // this is the copy to drop. A direct message is addressed by construction and `app_mention` is
  // documented for channels, so a DM is kept whether or not it names the bot — dropping it would
  // silently lose a message the person expects an answer to.
  if (!direct && mention && text.includes(mention)) return null;
  const stripped = direct && mention ? text.replaceAll(mention, '') : text;
  return { userId: event.user, text: stripped.trim(), mentioned: direct, files };
}

/**
 * A real Slack connection, in Socket Mode.
 *
 * One app now carries chat and approvals, because one process — this host — holds both
 * connections; the "two apps" reasoning from before Plan 8b is gone with the second process.
 * Slack still routes each Socket Mode event to exactly one open connection per app, but there is
 * only one connection now, so there is nothing to split between.
 *
 * Both the action and the view registrations are catch-alls. The contract takes one action
 * handler and one view handler and dispatches on the id itself, so there is nothing for Bolt to
 * route. Every interaction Slack delivers is acknowledged, and one this host did not post is
 * acked and dropped by the handler above rather than ignored by Bolt. Acking something unknown
 * costs nothing; leaving it unacked makes Slack show the user an error for a message the host
 * has no opinion about.
 */
export function boltTransport(config: SlackConfig, log: Logger, storageDir: string): SlackTransport {
  const bolt = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;
  let messageHandler: ((message: SlackInbound) => Promise<void>) | null = null;

  /** Slack drops an interaction that is not acknowledged within three seconds. */
  const ackFirst = async (ack: () => Promise<unknown>): Promise<void> => {
    try {
      await ack();
    } catch (err) {
      log.error('ack failed', err);
    }
  };

  bolt.action(/.*/, async ({ ack, body, action }) => {
    await ackFirst(ack);
    if (!actionHandler) {
      log.warn('a Slack action arrived before a handler was registered');
      return;
    }
    await actionHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      // The channel the interactive message lives in.
      channel: (body as { channel?: { id?: string } }).channel?.id ?? '',
      actionId: (action as { action_id?: string }).action_id ?? '',
      value: (action as { value?: string }).value ?? '',
      triggerId: (body as { trigger_id?: string }).trigger_id ?? null,
      messageTs: (body as { message?: { ts?: string } }).message?.ts ?? null,
    });
  });

  bolt.view(/.*/, async ({ ack, body, view }) => {
    await ackFirst(ack);
    if (!viewHandler) {
      log.warn('a Slack view submission arrived before a handler was registered');
      return;
    }
    await viewHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      callbackId: view.callback_id,
      privateMetadata: view.private_metadata ?? '',
      state: (view.state as { values?: Record<string, Record<string, { value?: string | null }>> }).values ?? {},
    });
  });

  const deliver = async (raw: RawMessage, botUserId: string | undefined): Promise<void> => {
    if (!messageHandler) {
      log.warn('a Slack message arrived before a handler was registered');
      return;
    }
    const classified = classifyMessage(raw, botUserId);
    if (!classified) return;
    const files = await downloadAttachments(raw.ts, classified.files, { token: config.botToken, storageDir, log });
    await messageHandler({
      userId: classified.userId,
      channel: raw.channel,
      text: classified.text,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      mentioned: classified.mentioned,
      files,
    });
  };
  bolt.event('message', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));
  bolt.event('app_mention', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    start: () => bolt.start().then(() => undefined),
    stop: () => bolt.stop().then(() => undefined),
  };

  return { api: webClientApi(bolt.client), events };
}
