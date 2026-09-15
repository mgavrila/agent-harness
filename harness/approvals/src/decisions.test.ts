import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { decideApproval, threadReplyText } from './decisions.js';
import { FakeCoreToolsClient, FakeSlack, useTestDb } from './testing.js';
import type { ApprovalRow } from './render.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

const base = {
  client: 'demo-practice',
  action: 'forms_release',
  payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
  summary: 'forms_release (external) requested by hermes',
  requestedBy: 'hermes',
  slackChannel: 'C0DEMO',
  slackTs: '1789000000.000001',
};

async function seed(over: Record<string, unknown> = {}): Promise<ApprovalRow> {
  const [row] = await db
    .insert(approvals)
    .values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z'), ...over })
    .returning();
  return row;
}

function deps(api: FakeSlack, core: FakeCoreToolsClient) {
  return { db, api, core, client: 'demo-practice', now };
}

describe('decideApproval', () => {
  it('approves, executes once through core-tools, edits the card and replies in thread', async () => {
    const row = await seed();
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'approved', decidedBy: 'U012' });
    expect(res).toMatchObject({ outcome: 'decided', status: 'approved' });
    expect(core.executed).toEqual([row.id]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'approved', decidedBy: 'U012' });
    expect(after.decidedAt).not.toBeNull();
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', ts: '1789000000.000001' });
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0].thread_ts).toBe('1789000000.000001');
    expect(api.posts[0].text).toContain('approved by');
  });

  it('declines with a note, never executes, and carries the note into the thread', async () => {
    const row = await seed();
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    await decideApproval(deps(api, core), {
      approvalId: row.id,
      decision: 'declined',
      decidedBy: 'U012',
      note: 'Use the Q4 roster, not Q3.',
    });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: 'Use the Q4 roster, not Q3.' });
    expect(api.posts[0].text).toContain('Use the Q4 roster, not Q3.');
    expect(api.posts[0].text).toContain('Nothing was sent');
  });

  it('refuses a row that is already decided', async () => {
    const row = await seed({ status: 'declined' });
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'approved', decidedBy: 'U012' });
    expect(res).toEqual({ outcome: 'not_actionable' });
    expect(core.executed).toEqual([]);
    expect(api.updates).toHaveLength(0);
  });

  it('refuses a row past its expiry', async () => {
    const row = await seed({ expiresAt: new Date('2026-09-15T11:00:00Z') });
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'approved', decidedBy: 'U012' });
    expect(res).toEqual({ outcome: 'not_actionable' });
  });

  it('refuses a row belonging to another client', async () => {
    const row = await seed({ client: 'other-clinic' });
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'approved', decidedBy: 'U012' });
    expect(res).toEqual({ outcome: 'not_actionable' });
  });

  it('reports a failed execution without claiming anything was sent', async () => {
    const row = await seed();
    const api = new FakeSlack();
    const core = new FakeCoreToolsClient();
    core.failExecuteWith = 'approval is not executable: it must be approved and unexpired';
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'approved', decidedBy: 'U012' });
    expect(res).toMatchObject({ outcome: 'decided', execution: { status: 'failed' } });
    expect(api.posts[0].text).toContain('Nothing was sent');
    expect(api.posts[0].text).not.toContain('Executed');
  });

  it('still records the decision when Slack is unreachable', async () => {
    const row = await seed();
    const api = new FakeSlack();
    api.failWith = 'channel_not_found';
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(api, core), { approvalId: row.id, decision: 'declined', decidedBy: 'U012' });
    expect(res).toMatchObject({ outcome: 'decided', status: 'declined' });
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('declined');
  });
});

describe('threadReplyText', () => {
  it('withholds a note that fails the redaction check', async () => {
    const row = await seed({ status: 'declined', decidedBy: 'U012', decisionNote: 'bad ssn 123-45-6789' });
    const text = threadReplyText(row);
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('withheld');
  });
});
