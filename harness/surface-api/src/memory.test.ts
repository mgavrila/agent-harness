import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { MemorySurface } from './testing.js';
import type { ActionEvent, Card, Form, FormEvent } from './types.js';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'demo_card',
  title: 'Approval needed',
  subtitle: 'forms_release (external) requested by hermes',
  notice: 'Approval needed: forms_release (external) requested by hermes',
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

  it('fails every call while failWith is set, the way an unreachable transport does', async () => {
    const surface = new MemorySurface();
    surface.failWith = 'conversation_not_found';
    await expect(surface.postCard('memory', card())).rejects.toThrow('conversation_not_found');
  });

  it('spells a mention the way a surface with no mention syntax can', () => {
    expect(new MemorySurface().mention('U012')).toBe('@U012');
  });
});
