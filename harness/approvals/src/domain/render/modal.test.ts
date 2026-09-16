import { describe, it, expect } from 'vitest';
import { editModalView, parseEditModalMetadata } from './modal.js';
import { EDIT_MODAL_CALLBACK_ID, type ApprovalRow } from './types.js';

function row(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    client: 'demo-practice',
    action: 'forms_release',
    payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
    payloadEncrypted: null,
    summary: 'forms_release (external) requested by hermes',
    requestedBy: 'hermes',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    expiresAt: new Date('2026-09-16T12:00:00Z'),
    idempotencyKey: 'demo-practice:forms_release:abc',
    slackChannel: null,
    slackTs: null,
    createdAt: new Date('2026-09-15T12:00:00Z'),
    ...over,
  } as ApprovalRow;
}

describe('editModalView', () => {
  it('carries the approval id and channel in private_metadata', () => {
    const view = editModalView(row().id, 'C0DEMO') as { callback_id: string; private_metadata: string };
    expect(view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata)).toEqual({ approval_id: row().id, channel: 'C0DEMO' });
  });
});

describe('parseEditModalMetadata', () => {
  it('round-trips what editModalView encoded', () => {
    const view = editModalView(row().id, 'C0DEMO') as { private_metadata: string };
    expect(parseEditModalMetadata(view.private_metadata)).toEqual({ approvalId: row().id, channel: 'C0DEMO' });
  });

  it('returns null for anything that is not the expected shape', () => {
    expect(parseEditModalMetadata('not-json')).toBeNull();
    expect(parseEditModalMetadata(row().id)).toBeNull();
    expect(parseEditModalMetadata('{}')).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: row().id }))).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: '', channel: 'C0DEMO' }))).toBeNull();
    expect(parseEditModalMetadata(JSON.stringify({ approval_id: row().id, channel: '' }))).toBeNull();
  });
});
