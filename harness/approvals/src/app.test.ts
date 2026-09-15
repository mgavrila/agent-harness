import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { registerApprovalHandlers, type ActionArgs, type HandlerRegistry, type ViewArgs } from './app.js';
import { APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID, EDIT_MODAL_CALLBACK_ID } from './render.js';
import { FakeCoreToolsClient, FakeSlack, useTestDb } from './testing.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

/** Collects handlers so a test can invoke one the way Bolt would. */
class Registry implements HandlerRegistry {
  actions = new Map<string, (args: ActionArgs) => Promise<void>>();
  views = new Map<string, (args: ViewArgs) => Promise<void>>();
  action(id: string, handler: (args: ActionArgs) => Promise<void>): void {
    this.actions.set(id, handler);
  }
  view(id: string, handler: (args: ViewArgs) => Promise<void>): void {
    this.views.set(id, handler);
  }
}

async function seed() {
  const [row] = await db
    .insert(approvals)
    .values({
      client: 'demo-practice',
      action: 'forms_release',
      payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
      summary: 'forms_release (external) requested by hermes',
      requestedBy: 'hermes',
      idempotencyKey: 'k1',
      expiresAt: new Date('2026-09-16T12:00:00Z'),
      slackChannel: 'C0DEMO',
      slackTs: '1789000000.000001',
    })
    .returning();
  return row;
}

function wire(allowedUsers: ReadonlySet<string> = new Set(['U012'])) {
  const registry = new Registry();
  const api = new FakeSlack();
  const core = new FakeCoreToolsClient();
  registerApprovalHandlers(registry, { db, api, core, client: 'demo-practice', now, allowedUsers });
  return { registry, api, core };
}

const acked = () => {
  let count = 0;
  return { ack: async () => { count += 1; }, calls: () => count };
};

describe('approval handlers', () => {
  it('registers exactly the three buttons and the modal', () => {
    const { registry } = wire();
    expect([...registry.actions.keys()].sort()).toEqual([APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID].sort());
    expect([...registry.views.keys()]).toEqual([EDIT_MODAL_CALLBACK_ID]);
  });

  it('approves and executes when the Approve button is pressed by an allowed user', async () => {
    const row = await seed();
    const { registry, core } = wire();
    const a = acked();
    await registry.actions.get(APPROVE_ACTION_ID)!({ ack: a.ack, userId: 'U012', channel: 'C0DEMO', value: row.id });
    expect(a.calls()).toBe(1);
    expect(core.executed).toEqual([row.id]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('approved');
  });

  it('declines with no note when the Decline button is pressed', async () => {
    const row = await seed();
    const { registry, core } = wire();
    const a = acked();
    await registry.actions.get(DECLINE_ACTION_ID)!({ ack: a.ack, userId: 'U012', channel: 'C0DEMO', value: row.id });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: null });
  });

  it('opens the note modal on Edit and changes nothing yet', async () => {
    const row = await seed();
    const { registry, api } = wire();
    const a = acked();
    await registry.actions.get(EDIT_ACTION_ID)!({ ack: a.ack, userId: 'U012', channel: 'C0DEMO', value: row.id, triggerId: 'T1' });
    expect(api.opened).toHaveLength(1);
    expect(api.opened[0].trigger_id).toBe('T1');
    expect(api.opened[0].view.private_metadata).toBe(row.id);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('declines with the note when the modal is submitted', async () => {
    const row = await seed();
    const { registry, core } = wire();
    const a = acked();
    await registry.views.get(EDIT_MODAL_CALLBACK_ID)!({
      ack: a.ack,
      userId: 'U012',
      channel: 'C0DEMO',
      privateMetadata: row.id,
      note: 'Use the Q4 roster.',
    });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: 'Use the Q4 roster.' });
  });

  it('acknowledges and posts nothing when the button names an unknown approval', async () => {
    const { registry, api, core } = wire();
    const a = acked();
    await registry.actions.get(APPROVE_ACTION_ID)!({
      ack: a.ack,
      userId: 'U012',
      channel: 'C0DEMO',
      value: '22222222-2222-4222-8222-222222222222',
    });
    expect(a.calls()).toBe(1);
    expect(core.executed).toEqual([]);
    expect(api.updates).toHaveLength(0);
  });

  it('refuses a non-allowed user, leaves the row pending, and tells them so', async () => {
    const row = await seed();
    const { registry, api, core } = wire(new Set(['U012']));
    const a = acked();
    await registry.actions.get(APPROVE_ACTION_ID)!({ ack: a.ack, userId: 'U999', channel: 'C0DEMO', value: row.id });
    expect(a.calls()).toBe(1);
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(api.ephemeral).toHaveLength(1);
    expect(api.ephemeral[0]).toMatchObject({
      channel: 'C0DEMO',
      user: 'U999',
      text: 'You are not an approver for this workspace.',
    });
    expect(api.updates).toHaveLength(0);
    expect(api.posts).toHaveLength(0);
  });

  it('fails closed when the allowlist is empty, refusing even a would-be approver', async () => {
    const row = await seed();
    const { registry, api, core } = wire(new Set());
    const a = acked();
    await registry.actions.get(APPROVE_ACTION_ID)!({ ack: a.ack, userId: 'U012', channel: 'C0DEMO', value: row.id });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(api.ephemeral).toHaveLength(1);
    expect(api.ephemeral[0].text).toBe('You are not an approver for this workspace.');
  });

  it('rejects a malformed approval id without throwing', async () => {
    const { registry, api, core } = wire();
    const a = acked();
    await expect(
      registry.actions.get(APPROVE_ACTION_ID)!({ ack: a.ack, userId: 'U012', channel: 'C0DEMO', value: 'not-a-uuid' }),
    ).resolves.toBeUndefined();
    expect(a.calls()).toBe(1);
    expect(core.executed).toEqual([]);
    expect(api.ephemeral).toHaveLength(1);
    expect(api.ephemeral[0]).toMatchObject({ channel: 'C0DEMO', user: 'U012', text: 'That approval no longer exists.' });
  });
});
