import { describe, expect, it } from 'vitest';
import { classifyMessage } from './bolt.js';

const BOT = 'UBOT';

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
});
