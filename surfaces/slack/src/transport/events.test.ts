import { describe, expect, it, vi } from 'vitest';
import type { ActionEvent, FormEvent } from '@harness/surface-api';
import { slackConfig } from '../config.js';
import { createSlackSession } from '../session.js';
import { eventsTransport, SLACK_MOUNT_PATH } from './events.js';
import { FakeSlack } from './fake.js';
import { signRequest } from './signature.js';
import type { SlackInbound, SlackTransport } from './types.js';

const SECRET = 'a-signing-secret';
const env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: SECRET, SLACK_APPROVALS_CHANNEL: 'C0DEMO' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * The transport under test, over the fake Web API.
 *
 * The fake is passed in rather than constructed inside: `eventsTransport`'s fourth parameter
 * defaults to a real `WebClient`, and `start()` calls `auth.test`, so a test that let it default
 * would make an HTTPS round trip to slack.com with a fake token and reject. It is also the only
 * way the bot identity these cases assert against — `U0BOTUSER` — can be known.
 */
function transport(): { t: SlackTransport; api: FakeSlack } {
  const api = new FakeSlack();
  return { t: eventsTransport(slackConfig(env), log, '/nonexistent/storage', api), api };
}

/** A signed request, as the host would hand one over. */
function signed(body: string, contentType = 'application/json', over: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST',
    path: '',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signRequest(SECRET, timestamp, body),
      ...over,
    },
    body,
  };
}

const eventCallback = (event: Record<string, unknown>, teamId = 'T0WORKSPACE'): string =>
  JSON.stringify({ type: 'event_callback', team_id: teamId, event });

const channelMention = {
  type: 'app_mention',
  channel: 'C0ROOM',
  user: 'U0PERSON',
  text: 'hello there',
  ts: '1789000000.000100',
};

/** Wait for what an acknowledged request started; the door answers before the work is done. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the Slack transport as an HTTP door', () => {
  it('is mounted at one path, for events and for interactions alike', () => {
    expect(transport().t.http?.path).toBe(SLACK_MOUNT_PATH);
    expect(SLACK_MOUNT_PATH).toBe('slack/events');
  });

  it('answers the url_verification handshake with the challenge it was given', async () => {
    const { t } = transport();
    const response = await t.http!.handle(signed(JSON.stringify({ type: 'url_verification', challenge: 'c-123' })));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body ?? '{}')).toEqual({ challenge: 'c-123' });
    expect(response.refusal).toBeUndefined();
  });

  it('refuses an unsigned request, a badly signed one and a stale one, each by its own reason', async () => {
    const { t } = transport();
    const body = eventCallback(channelMention);
    const unsigned = { method: 'POST', path: '', headers: { 'content-type': 'application/json' }, body };
    expect((await t.http!.handle(unsigned)).refusal).toEqual({ reason: 'missing_signature' });
    const wrong = signed(body);
    expect(
      (await t.http!.handle({ ...wrong, headers: { ...wrong.headers, 'x-slack-signature': 'v0=nope' } })).refusal,
    ).toEqual({ reason: 'bad_signature' });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(
      (
        await t.http!.handle({
          ...wrong,
          headers: {
            ...wrong.headers,
            'x-slack-request-timestamp': old,
            'x-slack-signature': signRequest(SECRET, old, body),
          },
        })
      ).refusal,
    ).toEqual({ reason: 'stale_timestamp' });
  });

  it('drops nothing of a refused request into the answer', async () => {
    const { t } = transport();
    const body = eventCallback({ ...channelMention, text: 'a-secret-sentence' });
    const response = await t.http!.handle({ method: 'POST', path: '', headers: {}, body });
    expect(response.status).toBe(401);
    expect(response.body ?? '').not.toContain('a-secret-sentence');
  });

  it('refuses a content type it does not serve', async () => {
    const response = await transport().t.http!.handle(signed('<xml/>', 'application/xml'));
    expect(response.status).toBe(415);
    expect(response.refusal).toEqual({ reason: 'unsupported_media_type' });
  });

  it('runs the pipeline for an event callback, after acknowledging it', async () => {
    const { t } = transport();
    await t.events.start();
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    const response = await t.http!.handle(signed(eventCallback(channelMention)));
    // Acknowledged before the turn: Slack retries anything it has not heard about in 3 seconds.
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      userId: 'U0PERSON',
      channel: 'C0ROOM',
      mentioned: true,
      teamId: 'T0WORKSPACE',
      files: [],
    });
  });

  it('asks who this app is once, at start, and strips that mention from the text', async () => {
    const { t, api } = transport();
    await t.events.start();
    // One `auth.test`, at start, and not one per delivery: it is the identity a socket's context
    // used to carry, and it does not change while a process runs.
    expect(api.authTestCalls).toBe(1);
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    await t.http!.handle(signed(eventCallback({ ...channelMention, text: '<@U0BOTUSER> hello there' })));
    await settle();
    expect(seen[0].text).toBe('hello there');
    expect(api.authTestCalls).toBe(1);
  });

  it('drops a retried delivery and tells Slack not to send it again', async () => {
    const { t } = transport();
    await t.events.start();
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    const response = await t.http!.handle(
      signed(eventCallback(channelMention), 'application/json', { 'x-slack-retry-num': '1' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.['x-slack-no-retry']).toBe('1');
    await settle();
    // The first delivery is either in flight or finished; a second turn on one message is worse
    // than a message answered once and slowly.
    expect(seen).toEqual([]);
  });

  it('ignores an event it has no rule for, and says so to nobody', async () => {
    const { t } = transport();
    await t.events.start();
    t.events.onMessage(async () => {
      throw new Error('this event should not have been delivered');
    });
    for (const body of [
      eventCallback({ type: 'reaction_added', channel: 'C0ROOM', ts: '1789000000.000200' }),
      JSON.stringify({ type: 'event_callback' }),
      JSON.stringify({ type: 'something_new' }),
    ]) {
      expect((await t.http!.handle(signed(body))).status, body).toBe(200);
    }
    await settle();
  });

  it('refuses a body that is not the JSON it was told it would be', async () => {
    expect((await transport().t.http!.handle(signed('not json'))).refusal).toEqual({ reason: 'bad_request' });
  });
});

describe('the Slack transport and an interaction', () => {
  const form = (payload: unknown): string => `payload=${encodeURIComponent(JSON.stringify(payload))}`;

  it('delivers a block action to the session s action handler, which is where approvals listen', async () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    const seen: ActionEvent[] = [];
    session.onAction(async (event) => {
      seen.push(event);
    });
    const body = form({
      type: 'block_actions',
      user: { id: 'U0LEAD' },
      channel: { id: 'C0DEMO' },
      trigger_id: 'T-1',
      message: { ts: '1789000000.000300' },
      actions: [{ action_id: 'approve', value: 'a-uuid' }],
    });
    const response = await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'));
    expect(response.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      surface: 'slack',
      userId: 'U0LEAD',
      conversation: 'C0DEMO',
      actionId: 'approve',
      value: 'a-uuid',
      trigger: 'T-1',
    });
  });

  it('delivers a view submission with its metadata and its values', async () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    const seen: FormEvent[] = [];
    session.onFormSubmit(async (event) => {
      seen.push(event);
    });
    const body = form({
      type: 'view_submission',
      user: { id: 'U0LEAD' },
      view: {
        callback_id: 'approval_edit',
        private_metadata: 'an-approval-id',
        state: { values: { note_block: { note_input: { value: 'not this week' } } } },
      },
    });
    const response = await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'));
    // An empty 200 is what closes the modal, which is what accepting a submission means.
    expect(response.status).toBe(200);
    expect(response.body ?? '').toBe('');
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: 'U0LEAD', formId: 'approval_edit', metadata: 'an-approval-id' });
  });

  it('refuses a form body with no payload, and one whose payload is not JSON', async () => {
    const { t } = transport();
    for (const body of ['', 'nothing=here', 'payload=not-json']) {
      expect((await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'))).refusal, body).toEqual({
        reason: 'bad_request',
      });
    }
  });

  it('acknowledges an interaction it has no rule for rather than failing it', async () => {
    const { t } = transport();
    expect((await t.http!.handle(signed(form({ type: 'shortcut' }), 'application/x-www-form-urlencoded'))).status).toBe(
      200,
    );
  });
});

describe('the session over this transport', () => {
  it('offers the transport s door as its own, so the host can mount it', () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    expect(session.http?.path).toBe(SLACK_MOUNT_PATH);
  });
});
