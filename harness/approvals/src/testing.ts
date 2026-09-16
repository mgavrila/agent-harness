/** What a test of @harness/approvals reaches for: the two fakes, the test database, and one approval row. */
import type { ApprovalRow } from './domain/render/types.js';

export { FakeSlack } from './domain/slack/fake.js';
export { FakeCoreToolsClient } from './domain/execute/fake.js';
export { useTestDb } from '@harness/db/testing';

/**
 * One pending approval, as `approvals` would select it, with `over` applied
 * last. The rendering tests build every card and modal from this: the blocks
 * test and the modal test have to agree on what a row looks like, since the
 * modal's `private_metadata` is what routes a decision back to the card.
 *
 * Cast rather than constructed field by field: drizzle's inferred row type
 * carries generated columns this fixture does not need to restate.
 */
export function approvalRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
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
