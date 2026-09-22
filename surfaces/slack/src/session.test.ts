import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SurfaceAcceptedError, SurfaceError } from '@harness/shared';
import type { ActionEvent, Card, Form, FormEvent, MessageEvent } from '@harness/surface-api';
import { fakeSlackSession } from './testing.js';

const card: Card = {
  id: 'harness_approval',
  title: 'Approval needed',
  subtitle: 'a summary',
  notice: 'Approval needed: a summary',
  body: [{ text: 'a line' }],
  actions: [{ id: 'harness_approval_approve', label: 'Approve', style: 'primary', value: 'a1' }],
};

const form: Form = {
  id: 'harness_approval_edit_modal',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  fields: [{ id: 'harness_approval_note', label: 'What should change?', multiline: true, optional: false }],
  metadata: '{"approval_id":"a1"}',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-surface-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the Slack session', () => {
  it('names itself, and reports what Slack can do', () => {
    const { session } = fakeSlackSession();
    expect(session.name).toBe('slack');
    expect(session.capabilities).toEqual({
      forms: true,
      privateReply: true,
      update: true,
      streaming: true,
      inlineConfirm: false,
    });
    expect(session.defaultConversation).toBe('C0DEMO');
    expect(session.mention('U012')).toBe('<@U012>');
  });

  it('posts a card with the notice as its text and hands back a reference that names the surface', async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0].channel).toBe('C0DEMO');
    expect(api.posts[0].text).toBe('Approval needed: a summary');
    expect(api.posts[0].blocks).toHaveLength(3);
    expect(ref).toMatchObject({ surface: 'slack', conversation: 'C0DEMO' });
    expect(ref.id).toMatch(/^\d+\.\d+$/);
  });

  it('edits the card the reference names', async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    await session.updateCard(ref, { ...card, notice: 'Approval a1 approved', actions: [] });
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', ts: ref.id, text: 'Approval a1 approved' });
  });

  it("replies in the card's thread when it is given a message to reply to", async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    await session.postText('C0DEMO', 'decided', { replyTo: ref });
    expect(api.posts[1]).toMatchObject({ channel: 'C0DEMO', text: 'decided', thread_ts: ref.id });
  });

  it('records the thread it replied in, and claims nothing for a notice', async () => {
    const { session, noted } = fakeSlackSession();
    const replyTo = { surface: 'slack', conversation: 'C0DEMO', id: '1700000000.000100' };
    await session.postText('C0DEMO', 'decided', { replyTo });
    // A later reply in that thread is addressed to the assistant with no mention, which is what
    // this record is for.
    expect(noted).toEqual([{ channel: 'C0DEMO', threadTs: '1700000000.000100' }]);
    await session.postText('C0DEMO', 'a top-level line', {});
    // A notice the host writes about a message it will not answer is not a turn, and a thread it
    // claimed would answer every later message in it with another notice.
    await session.postText('C0DEMO', 'You are not authorised to use this assistant.', { replyTo, kind: 'notice' });
    expect(noted).toHaveLength(1);
  });

  it('records the thread a stream opens in', async () => {
    const { session, noted } = fakeSlackSession();
    const replyTo = { surface: 'slack', conversation: 'C0DEMO', id: '1700000000.000200' };
    session.startStream('C0DEMO', { replyTo });
    expect(noted).toEqual([{ channel: 'C0DEMO', threadTs: '1700000000.000200' }]);
    session.startStream('C0DEMO');
    expect(noted).toHaveLength(1);
  });

  it('sends a private note as an ephemeral message', async () => {
    const { session, api } = fakeSlackSession();
    await session.postPrivate('C0DEMO', 'U012', 'You are not an approver for this workspace.');
    expect(api.ephemeral[0]).toEqual({
      channel: 'C0DEMO',
      user: 'U012',
      text: 'You are not an approver for this workspace.',
    });
  });

  it('uploads the file at the path it is given, with the comment as the initial comment', async () => {
    const { session, api } = fakeSlackSession();
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id\naetna\n');
    const out = await session.uploadFile('C0DEMO', {
      path: file,
      filename: 'aetna-roster.csv',
      comment: 'Release aetna-roster.csv',
    });
    expect(out).toEqual({ filename: 'aetna-roster.csv' });
    expect(api.uploads[0]).toMatchObject({
      channel_id: 'C0DEMO',
      filename: 'aetna-roster.csv',
      initial_comment: 'Release aetna-roster.csv',
    });
    expect(api.uploads[0].file.toString()).toContain('aetna');
  });

  it('never puts a filesystem path in the error when the file cannot be read', async () => {
    const { session, api } = fakeSlackSession();
    const missing = path.join(dir, 'gone.csv');
    const err = await session
      .uploadFile('C0DEMO', { path: missing, filename: 'gone.csv' })
      .then(() => null)
      .catch((caught: unknown) => caught);
    // This message is written into `tool_effects.last_error`, which is plaintext and which an
    // operator pastes into a ticket.
    expect(err).toBeInstanceOf(SurfaceError);
    expect((err as Error).message).toBe('slack: the staged file could not be read');
    expect((err as Error).message).not.toContain(missing);
    expect(api.uploads).toHaveLength(0);
  });

  /**
   * A transport failure has to arrive as a `SurfaceError`, because the contract says every method
   * rejects with one and because the message is written into `tool_effects.last_error`, which is
   * plaintext. The three cases below are the three that carry content the error must not repeat:
   * a card's text, a thread reply's text, and a staged file's name and path.
   */
  const failing = (): ReturnType<typeof fakeSlackSession> => {
    const wired = fakeSlackSession();
    wired.api.failWith = 'channel_not_found';
    return wired;
  };

  const rejection = async (run: Promise<unknown>): Promise<Error> => {
    const caught: unknown = await run.then(() => null).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(SurfaceError);
    return caught as Error;
  };

  it('reports a failed card post as a SurfaceError naming the operation, without the card text', async () => {
    const { session } = failing();
    const err = await rejection(session.postCard('C0DEMO', card));
    expect(err.message).toBe('slack: chat.postMessage failed: channel_not_found');
    expect(err.message).not.toContain('a summary');
    expect(err.message).not.toContain('Approval needed');
  });

  it('reports a failed reply as a SurfaceError naming the operation, without the text it carried', async () => {
    const { session } = failing();
    const err = await rejection(session.postText('C0DEMO', 'a roster was released', {}));
    expect(err.message).toBe('slack: chat.postMessage failed: channel_not_found');
    expect(err.message).not.toContain('roster');
  });

  it('reports a failed upload as a SurfaceError naming the operation, without the filename or path', async () => {
    const { session } = failing();
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id\naetna\n');
    const err = await rejection(session.uploadFile('C0DEMO', { path: file, filename: 'aetna-roster.csv' }));
    // Distinct from the unreadable-file message: that one fails before Slack is called at all.
    expect(err.message).toBe('slack: files.uploadV2 failed: channel_not_found');
    expect(err.message).not.toContain('aetna-roster.csv');
    expect(err.message).not.toContain(dir);
  });

  it('opens the form as a modal against the trigger it was handed', async () => {
    const { session, api } = fakeSlackSession();
    await session.openForm('T1', form);
    expect(api.opened[0].trigger_id).toBe('T1');
    expect(api.opened[0].view.callback_id).toBe('harness_approval_edit_modal');
  });

  it('says a card Slack accepted without a timestamp was accepted, not refused', async () => {
    const { session, api } = fakeSlackSession();
    api.acceptWithoutTs = true;
    const err = await rejection(session.postCard('C0DEMO', card));
    // The distinction the host acts on: the card is in the channel, so whoever holds a claim on
    // it must keep it rather than post a second card on the next tick.
    expect(err).toBeInstanceOf(SurfaceAcceptedError);
    expect(err.message).toBe('slack: the card was accepted without a timestamp');
    expect(api.posts).toHaveLength(1);
  });

  it('treats a text reply Slack accepted without a timestamp as sent, not refused', async () => {
    const { session, api } = fakeSlackSession();
    api.acceptWithoutTs = true;
    // Nothing stores a reply's reference, so an empty id is a success with no reference; a
    // rejection here would make the outbox retry a message that is already in the channel.
    const sent = await session.postText('C0DEMO', 'decided', {});
    expect(sent).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '' });
    expect(api.posts).toHaveLength(1);
  });

  it('refuses a conversation id that is not a Slack one, before it calls Slack', async () => {
    const { session, api } = fakeSlackSession();
    // An id the kernel's shape check admits and Slack's does not, spelling an SSN. The message
    // is written into the plaintext `tool_effects.last_error`, so it says the shape and not the
    // value: quoting the id would put a restricted identifier in a column operators paste around.
    const restricted = '123-45-6789';
    const err = await rejection(session.postCard(restricted, card));
    expect(err.message).toBe('slack: that is not a Slack conversation id (11 characters)');
    expect(err.message).not.toContain('123');
    expect(err.message).not.toContain('6789');
    await expect(session.postCard('not-a-channel', card)).rejects.toThrow(SurfaceError);
    expect(api.posts).toHaveLength(0);
  });

  it('turns a Slack block action into an ActionEvent', async () => {
    const { session, events } = fakeSlackSession();
    const seen: ActionEvent[] = [];
    session.onAction(async (event) => {
      seen.push(event);
    });
    await events.emitAction({
      userId: 'U012',
      channel: 'C0DEMO',
      actionId: 'harness_approval_approve',
      value: 'a1',
      triggerId: 'T1',
      messageTs: '1789000000.000001',
    });
    expect(seen[0]).toEqual({
      surface: 'slack',
      userId: 'U012',
      conversation: 'C0DEMO',
      message: { surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' },
      actionId: 'harness_approval_approve',
      value: 'a1',
      trigger: 'T1',
    });
  });

  it('turns a view submission into a FormEvent without having been told about the form', async () => {
    const { session, events } = fakeSlackSession();
    const seen: FormEvent[] = [];
    session.onFormSubmit(async (event) => {
      seen.push(event);
    });
    // No `openForm` first, on purpose: a modal opened before a restart submits after it, and the
    // adapter reads the answers out of the payload rather than out of anything it remembered.
    await events.emitView({
      userId: 'U012',
      callbackId: 'harness_approval_edit_modal',
      privateMetadata: '{"approval_id":"a1"}',
      state: { harness_approval_note: { harness_approval_note_input: { value: 'Use the Q4 roster.' } } },
    });
    // `toEqual`, not `toMatchObject`: the empty conversation is the point of the assertion, and a
    // partial match would pass in silence if the adapter started inventing one. Slack's view
    // submission carries no conversation for a modal opened from a button, so the host recovers
    // it from the metadata it put there.
    expect(seen[0]).toEqual({
      surface: 'slack',
      userId: 'U012',
      conversation: '',
      formId: 'harness_approval_edit_modal',
      metadata: '{"approval_id":"a1"}',
      values: { harness_approval_note: 'Use the Q4 roster.' },
    });
  });

  it('starts and stops the transport', async () => {
    const { session, events } = fakeSlackSession();
    await session.start();
    await session.stop();
    expect(events.started).toBe(true);
    expect(events.stopped).toBe(true);
  });

  it('streams a reply as one message edited in the thread it was asked to reply in', async () => {
    const { session, api } = fakeSlackSession();
    const replyTo = { surface: 'slack', conversation: 'C0DEMO', id: '1700000000.000100' };
    const stream = session.startStream('C0DEMO', { replyTo });
    stream.append('Hel');
    stream.append('lo');
    const ref = await stream.end();
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ channel: 'C0DEMO', thread_ts: '1700000000.000100', text: 'Hel' });
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', text: 'Hello' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: api.updates[0].ts });
  });
});

describe('inbound messages', () => {
  it('delivers a mention as a MessageEvent that names the surface and the message', async () => {
    const { session, events } = fakeSlackSession();
    const seen: MessageEvent[] = [];
    session.onMessage(async (e) => {
      seen.push(e);
    });
    await events.emitMessage({
      userId: 'U012',
      channel: 'C0DEMO',
      text: 'file these',
      ts: '1789000000.000001',
      threadTs: null,
      mentioned: true,
      files: [{ name: 'w9.pdf', path: '1789000000-000001-w9.pdf' }],
      teamId: 'T0WORKSPACE',
    });
    expect(seen).toEqual([
      {
        surface: 'slack',
        userId: 'U012',
        conversation: 'C0DEMO',
        text: 'file these',
        attachments: [{ name: 'w9.pdf', path: '1789000000-000001-w9.pdf' }],
        message: { surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' },
        mentioned: true,
        // The workspace the event came from, which is what the host matches against the key each
        // client's document claims. Without it a pooled host refuses every Slack event and a
        // dedicated one accepts every one, whichever workspace it arrived from.
        tenantHint: 'T0WORKSPACE',
      },
    ]);
  });

  it('carries no tenant hint for an event whose workspace the transport could not name', async () => {
    const { session, events } = fakeSlackSession();
    const seen: MessageEvent[] = [];
    session.onMessage(async (e) => {
      seen.push(e);
    });
    await events.emitMessage({
      userId: 'U012',
      channel: 'C0DEMO',
      text: 'hello',
      ts: '1789000000.000002',
      threadTs: null,
      mentioned: true,
      files: [],
      teamId: null,
    });
    expect(seen[0]).not.toHaveProperty('tenantHint');
  });
});

describe('which thread a reply lands in', () => {
  const CHANNEL = 'C0GENERAL';
  const DM = 'D0PRIVATE';

  /** The staged file an upload case releases, written into this test's own temporary directory. */
  const stagedFile = async (): Promise<string> => {
    const file = path.join(dir, 'roster.csv');
    await writeFile(file, 'payer_id\naetna\n');
    return file;
  };

  it('answers a top-level mention in the thread that message roots', async () => {
    const { session, api, transport } = fakeSlackSession();
    // What the transport recorded when the message arrived: a top-level message is its own root.
    transport.noteInbound(CHANNEL, '111.1', '111.1');
    await session.postText(CHANNEL, 'here you are', {
      replyTo: { surface: 'slack', conversation: CHANNEL, id: '111.1' },
    });
    expect(api.posts.at(-1)).toMatchObject({ channel: CHANNEL, thread_ts: '111.1' });
  });

  it('answers a mention inside a thread against that thread’s root, not the message’s own ts', async () => {
    const { session, api, transport } = fakeSlackSession();
    transport.noteInbound(CHANNEL, '222.2', '111.1');
    await session.postText(CHANNEL, 'still here', {
      replyTo: { surface: 'slack', conversation: CHANNEL, id: '222.2' },
    });
    // Slack documents a reply's own timestamp as the wrong handle for `thread_ts`; the root is
    // the one the transport already recorded when the message came in.
    expect(api.posts.at(-1)).toMatchObject({ thread_ts: '111.1' });
  });

  it('falls back to the message’s own ts for a thread it never saw arrive', async () => {
    const { session, api } = fakeSlackSession();
    // A process that restarted mid-turn, or a thread evicted from the bounded store. Today's
    // behaviour, kept: it is right for a top-level message and no worse than nothing for a reply.
    await session.postText(CHANNEL, 'hello', { replyTo: { surface: 'slack', conversation: CHANNEL, id: '333.3' } });
    expect(api.posts.at(-1)).toMatchObject({ thread_ts: '333.3' });
  });

  it('keeps a direct message flat, streamed and unstreamed alike', async () => {
    const { session, api, transport } = fakeSlackSession();
    transport.noteInbound(DM, '444.4', '444.4');
    const replyTo = { surface: 'slack' as const, conversation: DM, id: '444.4' };
    await session.postText(DM, 'hello', { replyTo });
    expect(api.posts.at(-1)?.thread_ts).toBeUndefined();
    const stream = session.startStream(DM, { replyTo });
    stream.append('hello');
    await stream.end();
    // A DM is already one person's conversation. Threading every answer inside it buries the
    // conversation under one-reply threads, which is what the live test found.
    expect(api.posts.at(-1)?.thread_ts).toBeUndefined();
  });

  it('threads a streamed reply in a channel, on the root', async () => {
    const { session, api, transport } = fakeSlackSession();
    transport.noteInbound(CHANNEL, '222.2', '111.1');
    const stream = session.startStream(CHANNEL, {
      replyTo: { surface: 'slack', conversation: CHANNEL, id: '222.2' },
    });
    stream.append('working');
    await stream.end();
    expect(api.posts.at(-1)).toMatchObject({ thread_ts: '111.1' });
  });

  it('follows the same rule for a released file', async () => {
    const { session, api, transport } = fakeSlackSession();
    const file = await stagedFile();
    transport.noteInbound(CHANNEL, '222.2', '111.1');
    await session.uploadFile(CHANNEL, {
      path: file,
      filename: 'roster.csv',
      replyTo: { surface: 'slack', conversation: CHANNEL, id: '222.2' },
    });
    expect(api.uploads.at(-1)).toMatchObject({ thread_ts: '111.1' });
    await session.uploadFile(DM, {
      path: file,
      filename: 'roster.csv',
      replyTo: { surface: 'slack', conversation: DM, id: '444.4' },
    });
    expect(api.uploads.at(-1)?.thread_ts).toBeUndefined();
  });
});

describe('acknowledging a message with a reaction', () => {
  const answering = { surface: 'slack', conversation: 'C0GENERAL', id: '111.1' };

  it('adds the reaction to the triggering message and removes it when the turn ends', async () => {
    const { session, api } = fakeSlackSession();
    const stop = await session.typing!('C0GENERAL', { replyTo: answering });
    expect(api.reactionsAdded).toEqual([{ channel: 'C0GENERAL', timestamp: '111.1', name: 'eyes' }]);
    expect(api.reactionsRemoved).toEqual([]);
    await stop();
    expect(api.reactionsRemoved).toEqual([{ channel: 'C0GENERAL', timestamp: '111.1', name: 'eyes' }]);
  });

  it('refuses a conversation that is not a Slack id before it reacts to anything', async () => {
    const { session, api } = fakeSlackSession();
    // The same check every other outbound method on this session makes, for the same reason: the
    // kernel admits any conversation-shaped string and this is where the real format is known.
    await expect(session.typing!('not a channel', { replyTo: answering })).rejects.toBeInstanceOf(SurfaceError);
    expect(api.reactionsAdded).toEqual([]);
  });

  it('does nothing at all when there is no message to react to', async () => {
    const { session, api } = fakeSlackSession();
    const stop = await session.typing!('C0GENERAL');
    await stop();
    // A reaction has to go on something. A channel is not a message.
    expect(api.reactionsAdded).toEqual([]);
    expect(api.reactionsRemoved).toEqual([]);
  });

  it('leaves the reaction and says so once when it cannot be removed', async () => {
    const { session, api, log } = fakeSlackSession();
    const stop = await session.typing!('C0GENERAL', { replyTo: answering });
    api.failWith = 'ratelimited';
    // A stale reaction is a smaller wrong than a turn that failed over an emoji, so the disposer
    // never throws: the host would log it, but the host would have had to stop the turn to find out.
    await expect(stop()).resolves.toBeUndefined();
    expect(log.warned).toContain('a Slack reaction could not be removed');
  });

  it('raises a reaction it could not add, so the turn it acknowledges removes nothing', async () => {
    const { session, api } = fakeSlackSession();
    api.failWith = 'missing_scope';
    await expect(session.typing!('C0GENERAL', { replyTo: answering })).rejects.toThrow(
      'slack: reactions.add failed: missing_scope',
    );
    api.failWith = undefined;
    // The host's own wrapper catches this and leaves its `stopTyping` null, so nothing is removed:
    // the disposer is not a blind undo, and nothing was added.
    expect(api.reactionsAdded).toEqual([]);
    expect(api.reactionsRemoved).toEqual([]);
  });
});
