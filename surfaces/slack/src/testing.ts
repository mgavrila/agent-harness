/** What a test of this adapter, or of the host, reaches for: the two fakes and a wired session. */
import type { SurfaceSession } from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { FakeSlack, FakeSlackEvents } from './transport/fake.js';

export { FakeSlack, FakeSlackEvents } from './transport/fake.js';

/**
 * A Slack session wired to the two fakes: the real `session.ts`, the real renderers, no socket.
 * The host's dual-surface test uses it to prove that what it does to a surface it loaded by name
 * arrives as Block Kit.
 *
 * `_opts` is declared for the shape the transport takes (`storageDir`), not read: this wiring
 * goes straight to `createSlackSession`, never through `boltTransport`, and `FakeSlackEvents`'s
 * `emitMessage` takes an already-downloaded `SlackInbound`, so no fake here ever touches a disk.
 */
export function fakeSlackSession(
  over: Partial<SlackConfig> = {},
  _opts: { storageDir?: string } = {},
): {
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
    ...over,
  };
  return { session: createSlackSession({ api, events }, config), api, events };
}
