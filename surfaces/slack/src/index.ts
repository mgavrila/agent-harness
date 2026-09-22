import { defineSurface, type Surface } from '@harness/surface-api';
import { slackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { eventsTransport } from './transport/events.js';

/**
 * Slack, as one messaging surface among several.
 *
 * The host loads this by the name a client document's `surfaces` gives and holds nothing but the
 * contract, so every Slack-shaped thing — Block Kit, a signed request, a `C…` channel id, a `ts` —
 * is behind this package's boundary. What the renderers emit is pinned byte for byte by their own
 * tests, because the cards in a live workspace must not change shape.
 *
 * This adapter holds no connection. Slack delivers to the URL the host mounts, and `start()` only
 * asks who this app is.
 */
export const surface: Surface = defineSurface({
  name: 'slack',
  version: '0.1.0',
  // The token this app posts as, and the secret every inbound request is verified against. There
  // is no app-level token: nothing here opens a socket. Both are names a document may point its
  // `{ env }` refs at; this adapter reads the resolved values and never an environment variable.
  secrets: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
  // Not `async`: building the transport opens nothing, so there is nothing here to await.
  connect: (deps) => {
    const config = slackConfig(deps.secretValues, deps.defaultConversation);
    return Promise.resolve(createSlackSession(eventsTransport(config, deps.log, deps.storageDir), config, deps.log));
  },
});
