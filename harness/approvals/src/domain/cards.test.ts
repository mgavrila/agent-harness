import { describe, expect, it } from 'vitest';
import { approvalRow as row } from '../testing.js';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  approvalCard,
  decidedCard,
  editForm,
  parseApprovalMetadata,
  payloadPreview,
} from './cards.js';

const CAN = { forms: true };

describe('payloadPreview', () => {
  it('pretty-prints an ordinary payload', () => {
    expect(payloadPreview({ a: 1 })).toContain('"a": 1');
  });

  it('withholds a payload that fails the redaction check', () => {
    const preview = payloadPreview({ args: { note: 'ssn 123-45-6789' } });
    expect(preview).toBe('payload withheld: it did not pass the redaction check');
    expect(preview).not.toContain('123-45-6789');
  });

  it('truncates a long payload', () => {
    const preview = payloadPreview({ blob: 'x'.repeat(5000) }, 200);
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('approvalCard', () => {
  /**
   * The whole card, as one object. The Slack adapter's own test holds the Block Kit this
   * renders to against what the app produced before Plan 6, so the pair of them is the proof
   * that the demo deployment's card did not move.
   */
  it('is exactly the card the Slack adapter pins its rendering against', () => {
    expect(approvalCard(row(), CAN)).toEqual({
      id: 'harness_approval',
      title: 'Approval needed',
      subtitle: 'forms_release (external) requested by u-coordinator',
      notice: 'Approval needed: forms_release (external) requested by u-coordinator',
      body: [
        {
          note: [
            { code: 'forms_release' },
            { text: ' · requested by ' },
            { code: 'u-coordinator' },
            { text: ' · expires ' },
            { at: new Date('2026-09-16T12:00:00Z') },
          ],
        },
        {
          code: '{\n  "tool": "forms_release",\n  "args": {\n    "file_id": "roster/aetna-abc123def456.csv"\n  }\n}',
        },
      ],
      actions: [
        { id: APPROVE_ACTION_ID, label: 'Approve', style: 'primary', value: row().id },
        { id: EDIT_ACTION_ID, label: 'Edit', style: 'default', value: row().id },
        { id: DECLINE_ACTION_ID, label: 'Decline', style: 'danger', value: row().id },
      ],
      footer: [{ text: 'Approval ' }, { code: row().id }],
    });
  });

  it('leaves Edit off a surface that cannot open a form, rather than offering a button that fails', () => {
    expect(approvalCard(row(), { forms: false }).actions.map((a) => a.id)).toEqual([
      APPROVE_ACTION_ID,
      DECLINE_ACTION_ID,
    ]);
  });
});

describe('decidedCard', () => {
  const approved = row({ status: 'approved', decidedBy: 'u-coordinator', decidedAt: new Date('2026-09-15T12:05:00Z') });

  it('replaces the buttons with the decision and says who decided it, by display name', () => {
    const card = decidedCard(approved, { executed: true, tool: 'forms_release', decidedByName: 'Coordinator' });
    expect(card.actions).toEqual([]);
    expect(card.notice).toBe(`Approval ${row().id} approved`);
    expect(card.body.at(-1)).toEqual({
      note: [
        { icon: 'approved' },
        { text: ' Approved by ' },
        { text: 'Coordinator' },
        { text: ' at ' },
        { at: new Date('2026-09-15T12:05:00Z') },
        { text: '.' },
        { text: '\nExecuted ' },
        { code: 'forms_release' },
        { text: '. Delivery is queued in the effects outbox.' },
      ],
    });
  });

  it('falls back to the raw decidedBy id when no display name is given', () => {
    const card = decidedCard(approved, { executed: true, tool: 'forms_release' });
    expect(card.body.at(-1)).toMatchObject({ note: expect.arrayContaining([{ text: 'u-coordinator' }]) });
  });

  it('withholds a decline note that fails the redaction check', () => {
    const card = decidedCard(
      row({ status: 'declined', decidedBy: 'u-coordinator', decisionNote: 'wrong ssn 123-45-6789' }),
      { executed: false, decidedByName: 'Coordinator' },
    );
    expect(JSON.stringify(card)).not.toContain('123-45-6789');
    expect(JSON.stringify(card)).toContain('note withheld');
  });

  it('withholds an execution error that fails the redaction check', () => {
    const card = decidedCard(approved, { executed: false, error: 'lookup failed for ssn 123-45-6789' });
    expect(JSON.stringify(card)).not.toContain('123-45-6789');
    expect(JSON.stringify(card)).toContain('Execution failed; see the audit log. Nothing was sent.');
  });

  it('shows a short safe execution error', () => {
    expect(JSON.stringify(decidedCard(approved, { executed: false, error: 'conversation_not_found' }))).toContain(
      'conversation_not_found',
    );
  });

  it('caps a long safe execution error at 300 characters', () => {
    const text = JSON.stringify(decidedCard(approved, { executed: false, error: 'x'.repeat(5000) }));
    const match = text.match(/x{50,}…/);
    expect(match).not.toBeNull();
    expect(match![0].length).toBeLessThanOrEqual(301);
  });

  it('renders the fallback when no execution error is given', () => {
    expect(JSON.stringify(decidedCard(approved, { executed: false }))).toContain(
      'Execution failed; see the audit log. Nothing was sent.',
    );
  });

  it('says someone, not a mention, when nobody is recorded as the decider', () => {
    const card = decidedCard(row({ status: 'declined' }), { executed: false });
    expect(JSON.stringify(card)).toContain('someone');
  });
});

describe('editForm', () => {
  it('carries the approval id and the conversation in its metadata', () => {
    const form = editForm(row().id, 'C0DEMO');
    expect(form.id).toBe(EDIT_FORM_ID);
    expect(form.fields.map((f) => f.id)).toEqual([EDIT_NOTE_FIELD_ID]);
    expect(JSON.parse(form.metadata)).toEqual({ approval_id: row().id, conversation: 'C0DEMO' });
  });
});

describe('parseApprovalMetadata', () => {
  it('round-trips what editForm encoded', () => {
    expect(parseApprovalMetadata(editForm(row().id, 'C0DEMO').metadata)).toEqual({
      approvalId: row().id,
      conversation: 'C0DEMO',
    });
  });

  it('still reads a form opened before Plan 6, which spelled the conversation `channel`', () => {
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id, channel: 'C0OLD' }))).toEqual({
      approvalId: row().id,
      conversation: 'C0OLD',
    });
  });

  it('returns null for anything that is not the expected shape', () => {
    expect(parseApprovalMetadata('not-json')).toBeNull();
    expect(parseApprovalMetadata(row().id)).toBeNull();
    expect(parseApprovalMetadata('{}')).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id }))).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: '', conversation: 'C0DEMO' }))).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id, conversation: '' }))).toBeNull();
  });
});
