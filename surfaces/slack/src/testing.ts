/** What a test of this adapter, or of the host, reaches for: the two fakes and a wired session. */
import type { Logger } from '@harness/shared';
import type { SurfaceSession } from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { FakeSlack, FakeSlackEvents } from './transport/fake.js';

export { FakeSlack, FakeSlackEvents } from './transport/fake.js';

/** A logger that keeps the first argument of every warning, so a test can read what was said. */
export interface RecordingLog extends Logger {
  /** Every warned message, in order. Whatever was passed beside it is Slack's and is not kept. */
  readonly warned: string[];
}

/** What the fixture's transport lets a test do that the contract does not: seed a thread's root. */
export interface FakeSlackTransport {
  /** Record that the message `ts` arrived in the thread `threadTs` roots, as a delivery would. */
  noteInbound(channel: string, ts: string, threadTs: string): void;
  rootOf(channel: string, ts: string): string;
}

/**
 * A Slack session wired to the two fakes: the real `session.ts`, the real renderers, no socket.
 * The host's dual-surface test uses it to prove that what it does to a surface it loaded by name
 * arrives as Block Kit.
 *
 * There is no `storageDir` to pass: this wiring goes straight to `createSlackSession`, never
 * through `eventsTransport`, and `FakeSlackEvents`'s `emitMessage` takes an already-downloaded
 * `SlackInbound`, so no fake here ever touches a disk.
 */
export function fakeSlackSession(over: Partial<SlackConfig> = {}): {
  session: SurfaceSession;
  api: FakeSlack;
  events: FakeSlackEvents;
  noted: { channel: string; threadTs: string }[];
  transport: FakeSlackTransport;
  log: RecordingLog;
} {
  const api = new FakeSlack();
  const events = new FakeSlackEvents();
  const config: SlackConfig = {
    botToken: 'xoxb-test',
    signingSecret: 'a-signing-secret',
    defaultConversation: 'C0DEMO',
    ...over,
  };
  // The thread memory itself lives in the real transport, which this wiring skips, and the rule
  // it answers is tested against the real memory in `transport/classify.test.ts`. What is recorded
  // here is the other half: which posts claim a thread, which is the session's decision.
  const noted: { channel: string; threadTs: string }[] = [];
  const warned: string[] = [];
  const log: RecordingLog = {
    info() {},
    warn: (message: string) => {
      warned.push(message);
    },
    error() {},
    warned,
  };
  // The roots a real transport learns from the deliveries it saw. A test seeds one with
  // `noteInbound` and the session reads it back through `rootOf`, which is the seam between them.
  const roots = new Map<string, string>();
  const transport = {
    api,
    events,
    // The wiring this fake skips is the one that asks who this app is, so it answers as a
    // workspace that has: a session built here reports itself live.
    identityState: () => 'confirmed' as const,
    notePostedIn: (channel: string, threadTs: string) => {
      noted.push({ channel, threadTs });
    },
    noteInbound: (channel: string, ts: string, threadTs: string) => {
      roots.set(`${channel}:${ts}`, threadTs);
    },
    rootOf: (channel: string, ts: string) => roots.get(`${channel}:${ts}`) ?? ts,
  };
  return { session: createSlackSession(transport, config, log), api, events, noted, transport, log };
}
