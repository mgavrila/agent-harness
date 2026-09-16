import { EDIT_MODAL_CALLBACK_ID, EDIT_NOTE_ACTION_ID, EDIT_NOTE_BLOCK_ID, type EditModalMetadata } from './types.js';

/**
 * Decode `private_metadata`. Slack's `view_submission` payload carries no
 * channel of its own — a modal opened by `trigger_id` from a button click is
 * not otherwise tied to one — so the channel the Edit button was pressed from
 * travels here instead, alongside the approval id. Anything that fails to
 * parse as this shape (a stale format, a tampered value) yields `null` so the
 * caller fails closed rather than guessing.
 */
export function parseEditModalMetadata(raw: string): EditModalMetadata | null {
  try {
    const parsed = JSON.parse(raw) as { approval_id?: unknown; channel?: unknown };
    if (typeof parsed.approval_id !== 'string' || parsed.approval_id === '') return null;
    if (typeof parsed.channel !== 'string' || parsed.channel === '') return null;
    return { approvalId: parsed.approval_id, channel: parsed.channel };
  } catch {
    return null;
  }
}

export function editModalView(approvalId: string, channel: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ approval_id: approvalId, channel }),
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
        block_id: EDIT_NOTE_BLOCK_ID,
        label: { type: 'plain_text', text: 'What should change?' },
        element: {
          type: 'plain_text_input',
          action_id: EDIT_NOTE_ACTION_ID,
          multiline: true,
          max_length: 1000,
          placeholder: { type: 'plain_text', text: 'Do not include patient or provider identifiers here.' },
        },
      },
    ],
  };
}
