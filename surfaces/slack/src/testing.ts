/** What a test of this adapter, or of the host, reaches for: the two fakes and a wired session. */
import { parseAllowedUsers, type SurfaceSession } from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { FakeSlack, FakeSlackEvents } from './transport/fake.js';

export { FakeSlack, FakeSlackEvents } from './transport/fake.js';

/**
 * A Slack session wired to the two fakes: the real `session.ts`, the real renderers, no socket.
 * The host's dual-surface test uses it to prove that what it does to a surface it loaded by name
 * arrives as Block Kit.
 */
export function fakeSlackSession(over: Partial<SlackConfig> = {}): {
  session: SurfaceSession;
  api: FakeSlack;
  events: FakeSlackEvents;
} {
  const api = new FakeSlack();
  const events = new FakeSlackEvents();
  const config: SlackConfig = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    defaultConversation: 'C0DEMO',
    allowedUsers: parseAllowedUsers('U012'),
    ...over,
  };
  return { session: createSlackSession({ api, events }, config), api, events };
}
