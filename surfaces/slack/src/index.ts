import { defineSurface, type Surface } from '@harness/surface-api';
import { slackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { boltTransport } from './transport/bolt.js';

/**
 * Slack, as one messaging surface among several.
 *
 * The host loads this by name from `HARNESS_SURFACES` and holds nothing but the contract, so
 * every Slack-shaped thing — Block Kit, Bolt, Socket Mode, a `C…` channel id, a `ts` — is behind
 * this package's boundary. The rendered cards are pinned byte for byte against what the
 * approvals app produced before Plan 6.
 */
export const surface: Surface = defineSurface({
  name: 'slack',
  version: '0.1.0',
  // Stripped from the environment of the core-tools child the host spawns. `SLACK_BOT_TOKEN` and
  // `SLACK_APP_TOKEN` are Hermes's, not this adapter's, and are listed because a process holding
  // an approver's credentials must not hand any Slack credential to a child either.
  secrets: ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  // Not `async`: building the transport opens nothing, so there is nothing here to await. The
  // socket is opened by `start()`, which the host calls once it is ready to take a button press.
  connect: (deps) => {
    const config = slackConfig(deps.env);
    return Promise.resolve(createSlackSession(boltTransport(config, deps.log), config));
  },
});
