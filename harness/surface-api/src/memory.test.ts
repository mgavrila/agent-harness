import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { MemorySurface } from './testing.js';
import type { ActionEvent, Card, Form, FormEvent, MessageEvent } from './types.js';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'demo_card',
  title: 'Approval needed',
  subtitle: 'forms_release (external) requested by u-coordinator',
  notice: 'Approval needed: forms_release (external) requested by u-coordinator',
  body: [{ code: '{ "a": 1 }' }],
  actions: [{ id: 'demo_approve', label: 'Approve', style: 'primary', value: 'a1' }],
  footer: [{ text: 'Approval ' }, { code: 'a1' }],
  ...over,
});

const form: Form = {
  id: 'demo_form',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  fields: [{ id: 'note', label: 'What should change?', multiline: true, optional: false }],
  metadata: '{"approval_id":"a1"}',
};

describe('MemorySurface', () => {
  it('records a posted card and hands back a reference that names itself', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
    expect(surface.cards).toHaveLength(1);
    expect(surface.cards[0].card.title).toBe('Approval needed');
  });

  it('replaces the card an update names, and refuses one it has never posted', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    await surface.updateCard(ref, card({ actions: [], notice: 'Approval a1 approved' }));
    expect(surface.cards).toHaveLength(1);
    expect(surface.cards[0].card.actions).toEqual([]);
    await expect(surface.updateCard({ ...ref, id: 'm99' }, card())).rejects.toThrow(SurfaceError);
  });

  it('refuses an update whose reference names a different surface', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    await expect(surface.updateCard({ ...ref, surface: 'slack' }, card())).rejects.toThrow(SurfaceError);
  });

  it('records a reply under the message it replies to', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    await surface.postText('memory', 'Approval a1 approved by @U012.', { replyTo: ref });
    expect(surface.texts[0]).toMatchObject({ text: 'Approval a1 approved by @U012.', replyTo: ref });
  });

  it('delivers a button press to the registered handler as an ActionEvent', async () => {
    const surface = new MemorySurface();
    const seen: ActionEvent[] = [];
    surface.onAction(async (event) => {
      seen.push(event);
    });
    await surface.postCard('memory', card());
    await surface.press('demo_approve', 'a1', 'U012');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ surface: 'memory', actionId: 'demo_approve', value: 'a1', userId: 'U012' });
    expect(seen[0].message).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });

  it('delivers a form submission with its metadata and values', async () => {
    const surface = new MemorySurface();
    const seen: FormEvent[] = [];
    surface.onFormSubmit(async (event) => {
      seen.push(event);
    });
    await surface.openForm('t1', form);
    await surface.submit('demo_form', { note: 'Use the Q4 roster.' }, 'U012');
    expect(surface.forms[0]).toMatchObject({ trigger: 't1' });
    expect(seen[0]).toMatchObject({
      formId: 'demo_form',
      metadata: '{"approval_id":"a1"}',
      values: { note: 'Use the Q4 roster.' },
    });
  });

  it('refuses to open a form when it was built without the capability', async () => {
    const surface = new MemorySurface({ capabilities: { forms: false } });
    await expect(surface.openForm('t1', form)).rejects.toThrow(/cannot open a form/);
  });

  it('reports a submission in the conversation of the card the form was opened from', async () => {
    const surface = new MemorySurface();
    const seen: FormEvent[] = [];
    surface.onFormSubmit(async (event) => {
      seen.push(event);
    });
    await surface.postCard('C0DEMO', card());
    await surface.openForm('t1', form);
    await surface.submit('demo_form', { note: 'Use the Q4 roster.' }, 'U012');
    expect(seen[0].conversation).toBe('C0DEMO');
  });

  it('records an upload and hands back the filename the host asked for', async () => {
    const surface = new MemorySurface();
    const sent = await surface.uploadFile('memory', {
      path: '/srv/harness-storage/out/roster/a.csv',
      filename: 'a.csv',
      comment: 'The Q4 roster.',
    });
    expect(sent).toEqual({ filename: 'a.csv' });
    expect(surface.uploads).toEqual([
      {
        conversation: 'memory',
        filename: 'a.csv',
        path: '/srv/harness-storage/out/roster/a.csv',
        comment: 'The Q4 roster.',
      },
    ]);
  });

  it('records an upload with no comment as a null one, not an absent key', async () => {
    const surface = new MemorySurface();
    await surface.uploadFile('memory', { path: '/srv/harness-storage/out/roster/b.csv', filename: 'b.csv' });
    expect(surface.uploads[0].comment).toBeNull();
  });

  it('records a private note, and refuses one when it was built without the capability', async () => {
    const surface = new MemorySurface();
    await surface.postPrivate('memory', 'U012', 'Only you can see this.');
    expect(surface.privates).toEqual([{ conversation: 'memory', userId: 'U012', text: 'Only you can see this.' }]);

    const quiet = new MemorySurface({ capabilities: { privateReply: false } });
    await expect(quiet.postPrivate('memory', 'U012', 'nope')).rejects.toThrow(/cannot send a private note/);
    expect(quiet.privates).toEqual([]);
  });

  it('refuses to update a card when it was built without the capability', async () => {
    const surface = new MemorySurface({ capabilities: { update: false } });
    const ref = await surface.postCard('memory', card());
    await expect(surface.updateCard(ref, card({ actions: [] }))).rejects.toThrow(/cannot update a message/);
    expect(surface.cards[0].card.actions).toHaveLength(1);
  });

  it('flags itself started and stopped, so a host test can prove it ran the lifecycle', async () => {
    const surface = new MemorySurface();
    expect(surface.started).toBe(false);
    expect(surface.stopped).toBe(false);
    await surface.start();
    expect(surface.started).toBe(true);
    expect(surface.stopped).toBe(false);
    await surface.stop();
    expect(surface.stopped).toBe(true);
  });

  it('declares streaming and no inline confirm, and reports both flags', () => {
    const surface = new MemorySurface();
    expect(surface.capabilities).toEqual({
      forms: true,
      privateReply: true,
      update: true,
      streaming: true,
      inlineConfirm: false,
    });
  });

  it('delivers a said message to the registered handler, mentioned by default', async () => {
    const surface = new MemorySurface();
    const seen: MessageEvent[] = [];
    surface.onMessage(async (event) => {
      seen.push(event);
    });
    await surface.say('U012', 'hello');
    expect(seen).toEqual([
      {
        surface: 'memory',
        userId: 'U012',
        conversation: 'memory',
        text: 'hello',
        attachments: [],
        message: null,
        mentioned: true,
      },
    ]);
    await surface.say('U012', 'in a channel', { mentioned: false, conversation: 'C1' });
    expect(seen[1]).toMatchObject({ mentioned: false, conversation: 'C1' });
  });

  it('refuses to say anything before a handler is registered', async () => {
    await expect(new MemorySurface().say('U012', 'x')).rejects.toThrow(/no message handler/);
  });

  it('streams: appends accumulate, end records the text as a posted message and hands back its reference', async () => {
    const surface = new MemorySurface();
    const stream = surface.startStream('memory');
    stream.append('Hel');
    stream.append('lo');
    expect(surface.streams).toEqual([{ conversation: 'memory', text: 'Hello', ended: false, replyTo: null }]);
    const ref = await stream.end();
    expect(surface.streams[0].ended).toBe(true);
    expect(surface.texts).toEqual([{ conversation: 'memory', text: 'Hello', replyTo: null }]);
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });

  it('refuses a stream when the capability is off', () => {
    const surface = new MemorySurface({ capabilities: { streaming: false } });
    expect(() => surface.startStream('memory')).toThrow(SurfaceError);
  });

  it('fails every call while failWith is set, the way an unreachable transport does', async () => {
    const surface = new MemorySurface();
    surface.failWith = 'conversation_not_found';
    await expect(surface.postCard('memory', card())).rejects.toThrow('conversation_not_found');
  });

  it('spells a mention the way a surface with no mention syntax can', () => {
    expect(new MemorySurface().mention('U012')).toBe('@U012');
  });
});
