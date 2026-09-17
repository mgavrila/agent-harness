import { describe, expect, it } from 'vitest';
import type { Form } from '@harness/surface-api';
import { formView, valuesOf } from './modal.js';

const form: Form = {
  id: 'harness_approval_edit_modal',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  intro:
    'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
  fields: [
    {
      id: 'harness_approval_note',
      label: 'What should change?',
      multiline: true,
      optional: false,
      maxLength: 1000,
      placeholder: 'Do not include patient or provider identifiers here.',
    },
  ],
  metadata: '{"approval_id":"11111111-1111-4111-8111-111111111111","conversation":"C0DEMO"}',
};

describe('formView', () => {
  it('renders the edit modal exactly as the Slack app rendered it before Plan 6', () => {
    // Serialised on both sides, for the same reason `blocks.test.ts` does it: what Slack receives
    // is the bytes, so key order is part of the pin.
    expect(JSON.stringify(formView(form))).toBe(
      JSON.stringify({
        type: 'modal',
        callback_id: 'harness_approval_edit_modal',
        private_metadata: '{"approval_id":"11111111-1111-4111-8111-111111111111","conversation":"C0DEMO"}',
        title: { type: 'plain_text', text: 'Send it back' },
        submit: { type: 'plain_text', text: 'Decline with note' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
            },
          },
          {
            type: 'input',
            block_id: 'harness_approval_note',
            label: { type: 'plain_text', text: 'What should change?' },
            element: {
              type: 'plain_text_input',
              action_id: 'harness_approval_note_input',
              multiline: true,
              max_length: 1000,
              placeholder: { type: 'plain_text', text: 'Do not include patient or provider identifiers here.' },
            },
          },
        ],
      }),
    );
  });

  it('marks an optional field optional and leaves out what the field does not declare', () => {
    const view = formView({
      ...form,
      intro: undefined,
      fields: [{ id: 'why', label: 'Why?', multiline: false, optional: true }],
    }) as { blocks: { type: string; optional?: boolean; element: Record<string, unknown> }[] };
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toEqual({
      type: 'input',
      block_id: 'why',
      optional: true,
      label: { type: 'plain_text', text: 'Why?' },
      element: { type: 'plain_text_input', action_id: 'why_input', multiline: false },
    });
  });

  it("reads a submitted view's values back under the block ids, with no form in hand", () => {
    expect(
      valuesOf({ harness_approval_note: { harness_approval_note_input: { value: 'Use the Q4 roster.' } } }),
    ).toEqual({ harness_approval_note: 'Use the Q4 roster.' });
  });

  it('reads an empty answer as an empty string, and a view with no state as no values', () => {
    expect(valuesOf({ harness_approval_note: { harness_approval_note_input: { value: null } } })).toEqual({
      harness_approval_note: '',
    });
    expect(valuesOf({})).toEqual({});
  });
});
