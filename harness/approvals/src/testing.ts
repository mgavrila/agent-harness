/** What a test of @harness/approvals reaches for: the two fakes, the test database, and one approval. */
import type { approvals } from '@harness/db';
import type { ApprovalRow } from './domain/render/types.js';

export { FakeSlack } from './domain/slack/fake.js';
export { FakeCoreToolsClient } from './domain/execute/fake.js';
export { useTestDb } from '@harness/db/testing';

/**
 * The action every test in this package parks: one roster file released to a
 * payer, requested by the agent. Stated once because the poller, the runner,
 * the Slack handlers, the decision path and the card renderer are five views
 * of the same approval, and a card whose summary no longer matches the row the
 * decision test decides on is two tests that only look like a pair.
 */
const PENDING = () => ({
  client: 'demo-practice',
  action: 'forms_release',
  payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
  summary: 'forms_release (external) requested by hermes',
  requestedBy: 'hermes',
  idempotencyKey: 'k1',
  // A fresh Date per call: a shared instance would be one mutable object
  // handed to every row in the suite.
  expiresAt: new Date('2026-09-16T12:00:00Z'),
});

/** Insert values for one pending approval, with `over` applied last. */
export function pendingApproval(over: Partial<typeof approvals.$inferInsert> = {}): typeof approvals.$inferInsert {
  return { ...PENDING(), ...over };
}

/**
 * The same approval as `approvals` would select it: posted to Slack, still
 * pending, with `over` applied last. This is what the renderers take.
 *
 * Cast rather than constructed field by field: drizzle's inferred row type
 * carries generated columns this fixture does not need to restate.
 */
export function approvalRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    ...PENDING(),
    id: '11111111-1111-4111-8111-111111111111',
    payloadEncrypted: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    idempotencyKey: 'demo-practice:forms_release:abc',
    surface: null,
    conversationId: null,
    messageRef: null,
    createdAt: new Date('2026-09-15T12:00:00Z'),
    ...over,
  } as ApprovalRow;
}
