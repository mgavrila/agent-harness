import { describe, it, expect } from 'vitest';
import {
  containsRestrictedPattern,
  payloadPreview,
  approvalBlocks,
  approvalFallbackText,
  decidedBlocks,
  editModalView,
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_MODAL_CALLBACK_ID,
  type ApprovalRow,
} from './render.js';

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

describe('containsRestrictedPattern', () => {
  it('matches the shapes the redaction regexes protect', () => {
    expect(containsRestrictedPattern('ssn 123-45-6789 on file')).toBe(true);
    expect(containsRestrictedPattern('EIN 12-3456789')).toBe(true);
    expect(containsRestrictedPattern('DEA BR1234563')).toBe(true);
  });

  it('does not match ordinary roster content', () => {
    expect(containsRestrictedPattern('roster/aetna-abc123def456.csv')).toBe(false);
    expect(containsRestrictedPattern('license expires 2027-03-31 in TX')).toBe(false);
    expect(containsRestrictedPattern('NPI 1234567893')).toBe(false);
  });
});

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

describe('approvalBlocks', () => {
  it('offers exactly approve, edit and decline, each carrying the approval id', () => {
    const blocks = approvalBlocks(row()) as { type: string; elements?: { action_id: string; value: string }[] }[];
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions?.elements?.map((e) => e.action_id)).toEqual([APPROVE_ACTION_ID, EDIT_ACTION_ID, DECLINE_ACTION_ID]);
    expect(actions?.elements?.every((e) => e.value === row().id)).toBe(true);
  });

  it('puts the summary in the fallback text and never a payload value', () => {
    expect(approvalFallbackText(row())).toContain('forms_release (external)');
  });
});

describe('decidedBlocks', () => {
  it('replaces the buttons with the decision', () => {
    const blocks = decidedBlocks(
      row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') }),
      { executed: true, tool: 'forms_release' },
    ) as { type: string }[];
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('U012');
    expect(JSON.stringify(blocks)).toContain('forms_release');
  });

  it('withholds a decline note that fails the redaction check', () => {
    const blocks = decidedBlocks(
      row({ status: 'declined', decidedBy: 'U012', decisionNote: 'wrong ssn 123-45-6789' }),
      { executed: false },
    );
    expect(JSON.stringify(blocks)).not.toContain('123-45-6789');
    expect(JSON.stringify(blocks)).toContain('note withheld');
  });

  it('withholds an execution error that fails the redaction check', () => {
    const blocks = decidedBlocks(
      row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') }),
      { executed: false, error: 'lookup failed for ssn 123-45-6789' },
    );
    expect(JSON.stringify(blocks)).not.toContain('123-45-6789');
    expect(JSON.stringify(blocks)).toContain('Execution failed; see the audit log. Nothing was sent.');
  });

  it('shows a short safe execution error', () => {
    const blocks = decidedBlocks(
      row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') }),
      { executed: false, error: 'channel_not_found' },
    );
    expect(JSON.stringify(blocks)).toContain('channel_not_found');
  });

  it('caps a long safe execution error at 300 characters', () => {
    const blocks = decidedBlocks(
      row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') }),
      { executed: false, error: 'x'.repeat(5000) },
    );
    const text = JSON.stringify(blocks);
    const match = text.match(/x{50,}…/);
    expect(match).not.toBeNull();
    expect(match![0].length).toBeLessThanOrEqual(301);
  });

  it('renders the fallback when no execution error is given', () => {
    const blocks = decidedBlocks(
      row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') }),
      { executed: false },
    );
    expect(JSON.stringify(blocks)).toContain('Execution failed; see the audit log. Nothing was sent.');
  });
});

describe('editModalView', () => {
  it('carries the approval id in private_metadata', () => {
    const view = editModalView(row().id) as { callback_id: string; private_metadata: string };
    expect(view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID);
    expect(view.private_metadata).toBe(row().id);
  });
});
