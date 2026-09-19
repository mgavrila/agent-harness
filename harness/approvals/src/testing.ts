/** What a test of @harness/approvals reaches for: the fakes, the test database, and one approval. */
import type { approvals } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import type { ApprovalRow } from './domain/cards.js';

export { FakeCoreToolsClient } from './domain/execute/fake.js';
export { useTestDb } from '@harness/db/testing';
export { MemorySurface } from '@harness/surface-api/testing';

/**
 * The action every test in this package parks: one roster file released to a payer, requested by
 * the agent. Stated once because the poller, the runner, the handlers, the decision path and the
 * card renderer are five views of the same approval, and a card whose summary no longer matches
 * the row the decision test decides on is two tests that only look like a pair.
 */
const PENDING = () => ({
  client: 'demo-practice',
  action: 'forms_release',
  payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
  summary: 'forms_release (external) requested by u-coordinator',
  requestedBy: 'u-coordinator',
  idempotencyKey: 'k1',
  // A fresh Date per call: a shared instance would be one mutable object handed to every row.
  expiresAt: new Date('2026-09-16T12:00:00Z'),
});

/**
 * Who a test acts as. A lead known on the memory surface by default, which is the approver the
 * decision, handler and dual-surface suites press buttons as; `over` applied last carries the
 * other roles and a surface map of a test's own.
 */
export function principal(over: Partial<Principal> = {}): Principal {
  return {
    id: 'u-coordinator',
    kind: 'user',
    level: 'lead',
    displayName: 'Coordinator',
    surfaces: { memory: 'U012' },
    attributes: {},
    ...over,
  };
}

/** Insert values for one pending approval, with `over` applied last. */
export function pendingApproval(over: Partial<typeof approvals.$inferInsert> = {}): typeof approvals.$inferInsert {
  return { ...PENDING(), ...over };
}

/**
 * The same approval as `approvals` would select it: not yet posted anywhere, still pending, with
 * `over` applied last. This is what the card builders take.
 *
 * Cast rather than constructed field by field: drizzle's inferred row type carries generated
 * columns this fixture does not need to restate.
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
