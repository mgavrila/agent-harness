import type { Logger } from '@harness/shared';
import { describe, expect, it, vi } from 'vitest';
import { classifyInbound, classifyMessage, createThreadMemory, THREAD_MEMORY_LIMIT } from './bolt.js';
import { FakeSlack } from './fake.js';
import type { RawMessage } from './types.js';

const BOT = 'UBOT';
/** This app, as the lookup knows itself: its bot user, and the bot id Bolt puts on the context. */
const SELF = { userId: BOT, botId: 'B_SELF' };

/** A logger that keeps its warnings, so a test can count them. */
function recordingLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

describe('classifyMessage', () => {
  it('takes a direct message as addressed', () => {
    expect(
      classifyMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U012', text: 'hi', ts: '1.1' }, BOT),
    ).toEqual({ userId: 'U012', text: 'hi', mentioned: true, files: [] });
  });

  it('takes a channel message as not addressed, and drops one that mentions the bot (app_mention carries it)', () => {
    expect(
      classifyMessage(
        { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', text: 'chatter', ts: '1.1' },
        BOT,
      ),
    ).toMatchObject({ mentioned: false });
    expect(
      classifyMessage(
        { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', text: `<@${BOT}> hi`, ts: '1.1' },
        BOT,
      ),
    ).toBeNull();
  });

  it('keeps a direct message that also carries the mention token, with the token stripped', () => {
    // Slack documents `app_mention` for channels; whether it fires in a DM is not something the
    // adapter should bet the whole message on.
    expect(
      classifyMessage(
        { type: 'message', channel: 'D1', channel_type: 'im', user: 'U012', text: `<@${BOT}> hi`, ts: '1.1' },
        BOT,
      ),
    ).toEqual({ userId: 'U012', text: 'hi', mentioned: true, files: [] });
  });

  it('takes an app_mention as addressed with the mention stripped', () => {
    expect(
      classifyMessage(
        { type: 'app_mention', channel: 'C1', user: 'U012', text: `<@${BOT}> file these`, ts: '1.1' },
        BOT,
      ),
    ).toEqual({ userId: 'U012', text: 'file these', mentioned: true, files: [] });
  });

  it('drops bot messages and every subtype but file_share, and keeps a file share with its files', () => {
    expect(
      classifyMessage(
        { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', bot_id: 'B1', text: 'x', ts: '1.1' },
        BOT,
      ),
    ).toBeNull();
    expect(
      classifyMessage(
        { type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: '1.1' },
        BOT,
      ),
    ).toBeNull();
    expect(
      classifyMessage(
        {
          type: 'message',
          subtype: 'file_share',
          channel: 'D1',
          channel_type: 'im',
          user: 'U012',
          text: '',
          ts: '1.1',
          files: [{ name: 'w9.pdf', url_private_download: 'https://files.slack.com/w9' }],
        },
        BOT,
      ),
    ).toEqual({
      userId: 'U012',
      text: '',
      mentioned: true,
      files: [{ name: 'w9.pdf', url: 'https://files.slack.com/w9' }],
    });
  });

  it("drops a notice from Slack's own system user, even in a direct message", () => {
    expect(
      classifyMessage(
        { type: 'message', channel: 'D1', channel_type: 'im', user: 'USLACKBOT', text: 'you were added', ts: '1.1' },
        BOT,
      ),
    ).toBeNull();
  });
});

describe('the thread rule', () => {
  /** The message the live report was about: a follow-up written in the thread, with no mention. */
  const reply = (over: Partial<RawMessage> = {}): RawMessage => ({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U012',
    text: 'who is your lead?',
    ts: '2.2',
    thread_ts: '1.1',
    ...over,
  });

  it('reports the thread a channel reply belongs to and leaves the decision to the caller', () => {
    expect(classifyMessage(reply(), BOT)).toEqual({
      userId: 'U012',
      text: 'who is your lead?',
      mentioned: false,
      files: [],
      threadTs: '1.1',
    });
    // A top-level message names itself in `thread_ts` once it has replies; that is not a reply.
    expect(classifyMessage(reply({ ts: '1.1', thread_ts: '1.1' }), BOT)).not.toHaveProperty('threadTs');
    expect(classifyMessage({ ...reply(), channel: 'D1', channel_type: 'im' }, BOT)).not.toHaveProperty('threadTs');
  });

  it('addresses a reply in a thread the assistant has posted in, text intact and no lookup', async () => {
    const api = new FakeSlack();
    const threads = createThreadMemory(api, recordingLog());
    threads.notePostedIn('C1', '1.1');
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({
      text: 'who is your lead?',
      mentioned: true,
    });
    expect(api.repliesCalls).toEqual([]);
  });

  it("stops treating a thread as somebody else's once the assistant has posted in it", async () => {
    const api = new FakeSlack();
    api.replies['C1:1.1'] = [{ user: 'U012' }, { user: 'U999' }];
    const threads = createThreadMemory(api, recordingLog());
    // A human thread nobody has mentioned the bot in: the first reply caches its root as theirs.
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
    // Someone mentions the bot inside that thread. The transport is what sees the root the
    // mention belongs to; the session only ever sees the mention's own timestamp.
    threads.noteInbound('C1', '3.3', '1.1');
    threads.notePostedIn('C1', '3.3');
    // The assistant is a party to the thread now, and no second lookup is needed to know it.
    expect(await classifyInbound(reply({ ts: '4.4' }), SELF, threads)).toMatchObject({ mentioned: true });
    expect(api.repliesCalls).toEqual([{ channel: 'C1', ts: '1.1', limit: 50 }]);
  });

  it('clears a negative entry for a thread whose root it is handed directly', async () => {
    const api = new FakeSlack();
    api.replies['C1:1.1'] = [{ user: 'U012' }];
    const threads = createThreadMemory(api, recordingLog());
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
    threads.notePostedIn('C1', '1.1');
    expect(await classifyInbound(reply({ ts: '4.4' }), SELF, threads)).toMatchObject({ mentioned: true });
    expect(api.repliesCalls).toHaveLength(1);
  });

  it('leaves a top-level channel message and a mention exactly as they were', async () => {
    const api = new FakeSlack();
    const threads = createThreadMemory(api, recordingLog());
    expect(
      await classifyInbound(
        { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', text: 'chatter', ts: '1.1' },
        SELF,
        threads,
      ),
    ).toMatchObject({ mentioned: false });
    expect(
      await classifyInbound(
        { type: 'app_mention', channel: 'C1', user: 'U012', text: `<@${BOT}> hi`, ts: '1.1' },
        SELF,
        threads,
      ),
    ).toMatchObject({ text: 'hi', mentioned: true });
    expect(
      await classifyInbound(
        { type: 'message', channel: 'D1', channel_type: 'im', user: 'U012', text: 'hi', ts: '1.1' },
        SELF,
        threads,
      ),
    ).toMatchObject({ mentioned: true });
    // None of the three hangs on a thread, so none of them costs a call.
    expect(api.repliesCalls).toEqual([]);
  });

  it('asks Slack once for a thread it has not seen, and caches a thread that is not the assistants', async () => {
    const api = new FakeSlack();
    api.replies['C1:1.1'] = [{ user: 'U012' }, { user: 'U999' }];
    const threads = createThreadMemory(api, recordingLog());
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
    expect(await classifyInbound(reply({ ts: '3.3' }), SELF, threads)).toMatchObject({ mentioned: false });
    expect(api.repliesCalls).toEqual([{ channel: 'C1', ts: '1.1', limit: 50 }]);
  });

  it("takes this app's own bot id or its bot user in the thread as the assistant, and caches that too", async () => {
    const byBotId = new FakeSlack();
    byBotId.replies['C1:1.1'] = [{ user: 'U012' }, { bot_id: 'B_SELF' }];
    const first = createThreadMemory(byBotId, recordingLog());
    expect(await classifyInbound(reply(), SELF, first)).toMatchObject({ mentioned: true });
    expect(await classifyInbound(reply({ ts: '3.3' }), SELF, first)).toMatchObject({ mentioned: true });
    expect(byBotId.repliesCalls).toHaveLength(1);

    const byUserId = new FakeSlack();
    byUserId.replies['C1:1.1'] = [{ user: 'U012' }, { user: BOT }];
    expect(await classifyInbound(reply(), SELF, createThreadMemory(byUserId, recordingLog()))).toMatchObject({
      mentioned: true,
    });
  });

  it("does not take another bot's thread as the assistant's", async () => {
    // A GitHub, PagerDuty or CI thread is one humans reply in at length. Answering there would be
    // an unasked-for turn in a thread this assistant never joined.
    const other = new FakeSlack();
    other.replies['C1:1.1'] = [{ user: 'U012' }, { bot_id: 'B_GITHUB' }];
    expect(await classifyInbound(reply(), SELF, createThreadMemory(other, recordingLog()))).toMatchObject({
      mentioned: false,
    });

    // And with no bot id of its own to compare against, a bot message it cannot identify is not it.
    const unknown = new FakeSlack();
    unknown.replies['C1:1.1'] = [{ bot_id: 'B_GITHUB' }];
    expect(await classifyInbound(reply(), { userId: BOT }, createThreadMemory(unknown, recordingLog()))).toMatchObject({
      mentioned: false,
    });
  });

  it('takes a failed lookup as not addressed, warns at most once a minute, and caches nothing', async () => {
    const api = new FakeSlack();
    const log = recordingLog();
    const threads = createThreadMemory(api, log);
    api.failWith = 'ratelimited';
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
    expect(await classifyInbound(reply({ ts: '3.3' }), SELF, threads)).toMatchObject({ mentioned: false });
    expect(log.warnings).toHaveLength(1);
    // A failure is not an answer, so nothing was remembered and the next lookup still runs.
    api.failWith = undefined;
    api.replies['C1:1.1'] = [{ bot_id: 'B_SELF' }];
    expect(await classifyInbound(reply({ ts: '4.4' }), SELF, threads)).toMatchObject({ mentioned: true });
  });

  it('keeps warning through a sustained outage rather than falling silent after the first line', async () => {
    // Every uncached thread reply is dropped while the lookup is failing, so an outage that says
    // nothing after its first line is an outage nobody sees.
    const api = new FakeSlack();
    const log = recordingLog();
    const threads = createThreadMemory(api, log);
    api.failWith = 'ratelimited';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-17T09:00:00Z'));
      expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
      expect(await classifyInbound(reply({ thread_ts: '7.7' }), SELF, threads)).toMatchObject({ mentioned: false });
      expect(log.warnings).toHaveLength(1);
      vi.setSystemTime(new Date('2026-09-17T09:01:00Z'));
      expect(await classifyInbound(reply({ thread_ts: '3.3' }), SELF, threads)).toMatchObject({ mentioned: false });
      expect(log.warnings).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns again as soon as a lookup has succeeded in between', async () => {
    const api = new FakeSlack();
    const log = recordingLog();
    const threads = createThreadMemory(api, log);
    api.failWith = 'ratelimited';
    expect(await classifyInbound(reply(), SELF, threads)).toMatchObject({ mentioned: false });
    api.failWith = undefined;
    api.replies['C1:9.9'] = [{ user: 'U012' }];
    expect(await classifyInbound(reply({ thread_ts: '9.9' }), SELF, threads)).toMatchObject({ mentioned: false });
    api.failWith = 'ratelimited';
    expect(await classifyInbound(reply({ thread_ts: '8.8' }), SELF, threads)).toMatchObject({ mentioned: false });
    expect(log.warnings).toHaveLength(2);
  });

  it('remembers the most recent threads only', async () => {
    const api = new FakeSlack();
    const threads = createThreadMemory(api, recordingLog());
    for (let i = 0; i <= THREAD_MEMORY_LIMIT; i += 1) threads.notePostedIn('C1', `t${i}`);
    // The newest key is still there, and the oldest was pushed out by the one that overflowed.
    expect(await classifyInbound(reply({ thread_ts: `t${THREAD_MEMORY_LIMIT}` }), SELF, threads)).toMatchObject({
      mentioned: true,
    });
    expect(await classifyInbound(reply({ thread_ts: 't0' }), SELF, threads)).toMatchObject({ mentioned: false });
    expect(api.repliesCalls).toEqual([{ channel: 'C1', ts: 't0', limit: 50 }]);
  });
});
