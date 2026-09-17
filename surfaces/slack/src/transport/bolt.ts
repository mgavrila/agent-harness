import { App, LogLevel } from '@slack/bolt';
import type { Logger } from '@harness/shared';
import type { SlackConfig } from '../config.js';
import type { SlackAction, SlackEvents, SlackTransport, SlackView } from './types.js';
import { webClientApi } from './web-client.js';

/**
 * A real Slack connection, in Socket Mode.
 *
 * The approvals host needs its own Slack app, not Hermes's. Slack routes each Socket Mode event
 * to exactly one of an app's open connections, so with Hermes's gateway and this process both
 * connected on one app token, roughly half of every button click and modal submission went to
 * Hermes, which has no handler for them, and the approval silently stayed pending. Two app
 * tokens means two independent event streams. `config.ts` deliberately does not fall back to
 * `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`: a fallback would make the broken configuration the
 * default again and fail intermittently rather than at startup.
 *
 * Both registrations are catch-alls. The contract takes one action handler and one view handler
 * and dispatches on the id itself, so there is nothing for Bolt to route. This is a change from
 * today's three action ids and one callback id: every interaction Slack delivers is now
 * acknowledged, and one this host did not post is acked and dropped by the handler above rather
 * than ignored by Bolt. Acking something unknown costs nothing; leaving it unacked makes Slack
 * show the user an error for a message the host has no opinion about.
 */
export function boltTransport(config: SlackConfig, log: Logger): SlackTransport {
  const bolt = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;

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

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    start: () => bolt.start().then(() => undefined),
    stop: () => bolt.stop().then(() => undefined),
  };

  return { api: webClientApi(bolt.client), events };
}
