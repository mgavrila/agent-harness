import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, providers, type Db } from '@harness/db';
import { defineTool, registerTools, ToolError, type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { approvalTools } from './approvals.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db);
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

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

const factory = () => {
  const server = new McpServer({ name: 'approvals-test', version: '0.0.0' });
  registerTools(server, [createProviderExternal, ...approvalTools], deps);
  return server;
};

async function park(client: Awaited<ReturnType<typeof makeTestClient>>['client'], args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'create_provider_external', arguments: args });
  return (res.structuredContent as { approval_id: string }).approval_id;
}

describe('approvals_execute', () => {
  it('executes an approved action once, audits it against the original tool, and records executed_at', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await park(client, { name: 'Dr. Approved' });
    await db.update(approvals).set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() }).where(eq(approvals.id, id));

    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    const out = (res.structuredContent as { result: { status: string; tool: string; result: { provider_id: string } } }).result;
    expect(out.status).toBe('executed');
    expect(out.tool).toBe('create_provider_external');
    expect(await db.select().from(providers)).toHaveLength(1);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('executed');
    expect(row.executedAt).not.toBeNull();
    const audits = await db.select().from(auditLog).where(eq(auditLog.approvalId, id));
    expect(audits.map((a) => `${a.tool}:${a.decision}`).sort()).toEqual(['create_provider_external:approval', 'create_provider_external:auto']);

    const again = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(again.isError).toBe(true);
    expect(await db.select().from(providers)).toHaveLength(1);
    await c();
  });

  it('refuses pending, declined, and expired approvals', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const pending = await park(client, { name: 'A' });
    const declined = await park(client, { name: 'B' });
    const expired = await park(client, { name: 'C' });
    await db.update(approvals).set({ status: 'declined' }).where(eq(approvals.id, declined));
    await db.update(approvals).set({ status: 'approved', expiresAt: new Date('2026-09-15T11:00:00Z') }).where(eq(approvals.id, expired));
    for (const id of [pending, declined, expired]) {
      const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
      expect(res.isError).toBe(true);
    }
    expect(await db.select().from(providers)).toHaveLength(0);
    await c();
  });

  it('rolls back to approved when the replayed handler throws', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await park(client, { name: 'Dr. Boom', explode: true });
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, id));
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('approved');
    expect(row.executedAt).toBeNull();
    const errors = await db.select().from(auditLog).where(eq(auditLog.decision, 'error'));
    expect(errors).toHaveLength(1);
    await c();
  });

  it('refuses an approval that belongs to another client', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await park(client, { name: 'Dr. Other' });
    await db.update(approvals).set({ status: 'approved', client: 'other-clinic' }).where(eq(approvals.id, id));
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    await c();
  });
});
