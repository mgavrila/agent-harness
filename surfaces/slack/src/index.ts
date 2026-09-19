import { defineSurface, type Surface } from '@harness/surface-api';
import { slackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { boltTransport } from './transport/bolt.js';

/**
 * Slack, as one messaging surface among several.
 *
 * The host loads this by name from `HARNESS_SURFACES` and holds nothing but the contract, so
 * every Slack-shaped thing — Block Kit, Bolt, Socket Mode, a `C…` channel id, a `ts` — is behind
 * this package's boundary. What the renderers emit is pinned byte for byte by their own tests,
 * because the cards in the demo workspace must not change shape.
 */
export const surface: Surface = defineSurface({
  name: 'slack',
  version: '0.1.0',
  // The one app's two tokens: chat and approvals share them, so there is nothing left to strip
  // that a second Slack app's credentials used to be.
  secrets: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  // Not `async`: building the transport opens nothing, so there is nothing here to await. The
  // socket is opened by `start()`, which the host calls once it is ready to take a button press.
  connect: (deps) => {
    const config = slackConfig(deps.env);
    return Promise.resolve(createSlackSession(boltTransport(config, deps.log, deps.storageDir), config));
  },
});
