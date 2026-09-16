import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, providers } from '@harness/db';
import { defineTool, ToolError } from '../registry.js';
import { approvalIdOf, connectTools, makeTestDeps, resultOf, useTestDb, type TestClient } from '../testing.js';
import { DEFAULT_POLICY } from '../policy.js';
import { approvalTools } from './approvals.js';

const db = useTestDb();
const deps = makeTestDeps(db);

const createProviderExternal = defineTool({
  name: 'create_provider_external',
  description: 'Creates a provider; external class so it needs approval',
  actionClass: 'external',
  input: z.object({ name: z.string(), explode: z.boolean().default(false) }),
  output: z.object({ provider_id: z.string() }),
  handler: async ({ name, explode }, d) => {
    if (explode) throw new ToolError('handler exploded');
    const [row] = await d.db.insert(providers).values({ client: d.client, name }).returning();
    return { provider_id: row.id };
  },
  recordIds: (_a, r) => [r.provider_id],
});

const replayableTools = [createProviderExternal, ...approvalTools];

const connectApprovals = () => connectTools('approvals-test', replayableTools, deps);

/** Call the external-class tool, which policy parks, and return the approval id. */
async function park(client: TestClient, args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'create_provider_external', arguments: args });
  return approvalIdOf(res);
}

describe('approvals_execute', () => {
  it('executes an approved action once, audits it against the original tool, and records executed_at', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Approved' });
    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, id));

    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    const out = resultOf<{ status: string; tool: string; result: { provider_id: string } }>(res);
    expect(out.status).toBe('executed');
    expect(out.tool).toBe('create_provider_external');
    expect(await db.select().from(providers)).toHaveLength(1);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('executed');
    expect(row.executedAt).not.toBeNull();
    const audits = await db.select().from(auditLog).where(eq(auditLog.approvalId, id));
    expect(audits.map((a) => `${a.tool}:${a.decision}`).sort()).toEqual([
      'create_provider_external:approval',
      'create_provider_external:auto',
    ]);

    const again = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(again.isError).toBe(true);
    expect(await db.select().from(providers)).toHaveLength(1);
  });

  it('refuses pending, declined, and expired approvals', async () => {
    const client = await connectApprovals();
    const pending = await park(client, { name: 'A' });
    const declined = await park(client, { name: 'B' });
    const expired = await park(client, { name: 'C' });
    await db.update(approvals).set({ status: 'declined' }).where(eq(approvals.id, declined));
    await db
      .update(approvals)
      .set({ status: 'approved', expiresAt: new Date('2026-09-15T11:00:00Z') })
      .where(eq(approvals.id, expired));
    for (const id of [pending, declined, expired]) {
      const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
      expect(res.isError).toBe(true);
    }
    expect(await db.select().from(providers)).toHaveLength(0);
  });

  it('rolls back to approved when the replayed handler throws', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Boom', explode: true });
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, id));
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('approved');
    expect(row.executedAt).toBeNull();
    const errors = await db.select().from(auditLog).where(eq(auditLog.decision, 'error'));
    expect(errors).toHaveLength(1);
  });

  it("carries the parking row's derived_from onto the audit row written at replay", async () => {
    const client = await connectApprovals();
    await park(client, { name: 'Dr. First' });
    const [firstAudit] = await db.select().from(auditLog);

    const res = await client.callTool({
      name: 'create_provider_external',
      arguments: { name: 'Dr. Second', derived_from: [firstAudit.id] },
    });
    const id = approvalIdOf(res);
    const parking = (await db.select().from(auditLog).where(eq(auditLog.approvalId, id)))[0];
    expect(parking.derivedFrom).toEqual([firstAudit.id]);

    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, id));
    const exec = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(exec.isError).toBeFalsy();

    const rows = await db.select().from(auditLog).where(eq(auditLog.approvalId, id));
    const auto = rows.find((r) => r.decision === 'auto')!;
    expect(auto.derivedFrom).toEqual(parking.derivedFrom);
  });

  it('refuses to replay an action whose class has since become blocked by policy', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Blocked' });
    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, id));

    // Same key as the parking deps, so the stored payload still decrypts and
    // the policy re-check is the only thing that can stop the replay.
    const strictDeps = makeTestDeps(db, {
      policy: { ...DEFAULT_POLICY, external: 'blocked' },
      encryptionKey: deps.encryptionKey,
    });
    const strictClient = await connectTools('approvals-test-blocked', replayableTools, strictDeps);
    const res = await strictClient.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('approved');
    expect(row.executedAt).toBeNull();
    expect(await db.select().from(providers)).toHaveLength(0);
  });

  it('refuses an approval that belongs to another client', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Other' });
    await db.update(approvals).set({ status: 'approved', client: 'other-clinic' }).where(eq(approvals.id, id));
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
  });
});
