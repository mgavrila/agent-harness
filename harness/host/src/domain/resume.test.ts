import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  createInProcessCoreToolsClient,
  postPendingApprovals,
  registerApprovalHandlers,
} from '@harness/approvals';
import { approvals, messages, runs } from '@harness/db';
import { COORDINATOR, HOST_PRINCIPAL, attachTestHandlers, hostFixture, useTestDb } from '../testing.js';
import { decisionDeps, resumeText } from './resume.js';

const db = useTestDb();

/** A member asks for something a member cannot do alone; a lead decides on the card. */
async function parked() {
  const f = await hostFixture(db, {
    trajectory: (request) =>
      request.input.text.startsWith('Approval ')
        ? [{ say: `Understood: ${request.input.text.split('.')[0]}.` }]
        : [
            { tool: 'harness_notify', args: { text: 'roster ready', idempotency_key: 'roster:1' } },
            { say: 'Waiting for approval.' },
          ],
    principals: [
      { ...COORDINATOR, id: 'u-member', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' } },
      COORDINATOR,
      HOST_PRINCIPAL,
    ],
  });
  attachTestHandlers(f.host);
  const core = createInProcessCoreToolsClient({
    db,
    config: f.host.config,
    client: 'test',
    servicePrincipal: HOST_PRINCIPAL,
  });
  registerApprovalHandlers(f.surface, decisionDeps(f.host, core));
  await f.surface.say('U345', 'send the roster');
  await postPendingApprovals({ db, surface: f.surface, client: 'test', now: f.host.now });
  const [row] = await db.select().from(approvals);
  expect(row.status).toBe('pending');
  return { f, row };
}

describe('resuming a thread after a decision', () => {
  it('approves, executes as the lead, and resumes the member thread with one host message', async () => {
    const { f, row } = await parked();
    await f.surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    const [after] = await db.select().from(approvals);
    expect(after).toMatchObject({ status: 'executed', decidedBy: 'u-coordinator' });
    // The host's message and the runtime's answer are on the member's thread, in order.
    const rows = await db.select().from(messages).orderBy(messages.createdAt);
    expect(rows.map((r) => [r.role, r.principalId])).toEqual([
      ['user', 'u-member'],
      ['assistant', 'u-member'],
      ['host', 'u-member'],
      ['assistant', 'u-member'],
    ]);
    expect(rows[2].content).toBe(
      `Approval ${row.id} for harness_notify was approved by Coordinator and executed: delivery is queued in the effects outbox. Continue the workflow from here.`,
    );
    expect(f.surface.texts.at(-1)?.text).toBe(
      `Understood: Approval ${row.id} for harness_notify was approved by Coordinator and executed: delivery is queued in the effects outbox.`,
    );
    // Three runs: the member's turn, the lead's execution, the member's resumed turn.
    const all = await db.select().from(runs);
    expect(all.map((r) => r.principalId).sort()).toEqual(['u-coordinator', 'u-member', 'u-member']);
    expect(all.every((r) => r.status === 'done')).toBe(true);
  });

  it('declines with a note and resumes with the note', async () => {
    const { f, row } = await parked();
    await f.surface.press(DECLINE_ACTION_ID, row.id, 'U012');
    const rows = await db.select().from(messages).where(eq(messages.role, 'host'));
    expect(rows[0].content).toBe(
      `Approval ${row.id} for harness_notify was declined by Coordinator. Nothing was sent.`,
    );
  });

  it('carries a decline note that passes the redaction check, and withholds one that does not', () => {
    const base = { status: 'declined', id: 'a1', action: 'forms_release' } as Parameters<typeof resumeText>[0]['row'];
    const decidedBy = COORDINATOR;
    expect(resumeText({ row: { ...base, decisionNote: 'Use the Q4 roster.' }, decidedBy })).toBe(
      'Approval a1 for forms_release was declined by Coordinator. Nothing was sent. Note: Use the Q4 roster.',
    );
    expect(resumeText({ row: { ...base, decisionNote: 'ssn 123-45-6789' }, decidedBy })).toBe(
      'Approval a1 for forms_release was declined by Coordinator. Nothing was sent. Note: (withheld: it did not pass the redaction check)',
    );
  });

  it('says execution failed when it did', () => {
    const row = { status: 'approved', id: 'a1', action: 'forms_release', decisionNote: null } as Parameters<
      typeof resumeText
    >[0]['row'];
    expect(resumeText({ row, decidedBy: COORDINATOR, execution: { status: 'failed', error: 'no payload' } })).toBe(
      'Approval a1 for forms_release was approved by Coordinator but execution failed: no payload. Nothing was sent.',
    );
  });

  it('does nothing for an approval parked outside a thread', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    const [row] = await db
      .insert(approvals)
      .values({
        client: 'test',
        action: 'x',
        payload: {},
        summary: 's',
        requestedBy: 'svc-local',
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: 'k',
        status: 'approved',
        decidedBy: 'u-coordinator',
      })
      .returning();
    const { resumeOnDecision } = await import('./resume.js');
    await resumeOnDecision(f.host)({ row, decidedBy: COORDINATOR, execution: { status: 'executed', tool: 'x' } });
    expect(f.runtime.requests).toHaveLength(0);
  });
});
