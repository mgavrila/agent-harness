import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import type { ActionEvent, Card, Form, FormEvent } from '@harness/surface-api';
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
    expect(session.capabilities).toEqual({ forms: true, privateReply: true, update: true });
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

  it('refuses a conversation id that is not a Slack one, before it calls Slack', async () => {
    const { session, api } = fakeSlackSession();
    await expect(session.postCard('not-a-channel', card)).rejects.toThrow(SurfaceError);
    await expect(session.postCard('not-a-channel', card)).rejects.toThrow(/slack: "not-a-channel"/);
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
});
