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
 * There is no `storageDir` to pass: this wiring goes straight to `createSlackSession`, never
 * through `boltTransport`, and `FakeSlackEvents`'s `emitMessage` takes an already-downloaded
 * `SlackInbound`, so no fake here ever touches a disk.
 */
export function fakeSlackSession(over: Partial<SlackConfig> = {}): {
  session: SurfaceSession;
  api: FakeSlack;
  events: FakeSlackEvents;
  noted: { channel: string; threadTs: string }[];
} {
  const api = new FakeSlack();
  const events = new FakeSlackEvents();
  const config: SlackConfig = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    defaultConversation: 'C0DEMO',
    ...over,
  };
  // The thread memory itself lives in the real transport, which this wiring skips, and the rule
  // it answers is tested against the real memory in `transport/bolt.test.ts`. What is recorded
  // here is the other half: which posts claim a thread, which is the session's decision.
  const noted: { channel: string; threadTs: string }[] = [];
  const transport = {
    api,
    events,
    notePostedIn: (channel: string, threadTs: string) => {
      noted.push({ channel, threadTs });
    },
  };
  return { session: createSlackSession(transport, config), api, events, noted };
}
