import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, encrypt, memoryEntries, records, threads } from '@harness/db';
import { ToolError } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import {
  approvalIdOf,
  connectTools,
  makeTestDeps,
  resultOf,
  textOf,
  useTestDb,
  TEST_PRINCIPAL,
  type TestClient,
} from '../testing.js';
import { DEFAULT_POLICY, mergePolicy } from '../domain/tooling/policy.js';
import { approvalTools } from './approvals.js';
import { memoryTools } from './memory.js';

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
    const [row] = await d.db
      .insert(records)
      .values({ client: d.client, pack: 'healthcare', kind: 'provider', name })
      .returning();
    return { provider_id: row.id };
  },
  recordIds: (_a, r) => [r.provider_id],
});

const purgeDestructive = defineTool({
  name: 'purge_destructive',
  description: 'Delete beyond repair; destructive class so a practitioner needs approval',
  actionClass: 'destructive',
  input: z.object({}),
  output: z.object({ purged: z.boolean() }),
  handler: async () => ({ purged: true }),
});

const replayableTools = [createProviderExternal, purgeDestructive, ...approvalTools];

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
    expect(await db.select().from(records)).toHaveLength(1);
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
    expect(await db.select().from(records)).toHaveLength(1);
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
    expect(await db.select().from(records)).toHaveLength(0);
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
      policy: mergePolicy(DEFAULT_POLICY, { classes: { external: 'blocked' } }),
      encryptionKey: deps.encryptionKey,
    });
    const strictClient = await connectTools('approvals-test-blocked', replayableTools, strictDeps);
    const res = await strictClient.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('approved');
    expect(row.executedAt).toBeNull();
    expect(await db.select().from(records)).toHaveLength(0);
  });

  it('refuses an approval that belongs to another client', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Other' });
    await db.update(approvals).set({ status: 'approved', client: 'other-clinic' }).where(eq(approvals.id, id));
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
  });

  it("replays a destructive approval at the level it was parked under, not the replaying service principal's level", async () => {
    const client = await connectApprovals();
    const res = await client.callTool({ name: 'purge_destructive', arguments: {} });
    const id = approvalIdOf(res);
    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, id));

    // The approvals host always replays as a service principal, for which `destructive` is
    // blocked outright. The approval must still execute: it was parked under a practitioner,
    // for whom `destructive` only needs approval, and that is the level the re-check uses.
    const asService = makeTestDeps(db, {
      principal: { ...TEST_PRINCIPAL, id: 'svc-test', kind: 'service', level: 'service' },
      encryptionKey: deps.encryptionKey,
    });
    const serviceClient = await connectTools('approvals-test-service', replayableTools, asService);
    const executed = await serviceClient.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    const out = resultOf<{ status: string; result: { purged: boolean } }>(executed);
    expect(out.status).toBe('executed');
    expect(out.result.purged).toBe(true);
  });

  it("falls back to the replaying principal's level for a row parked before levels were recorded", async () => {
    const asService = makeTestDeps(db, {
      principal: { ...TEST_PRINCIPAL, id: 'svc-test', kind: 'service', level: 'service' },
      encryptionKey: deps.encryptionKey,
    });
    // Simulate a pre-change row: the encrypted payload has no `level`, exactly what
    // `createOrReuseApproval` wrote before this fix.
    const [row] = await db
      .insert(approvals)
      .values({
        client: asService.client,
        action: 'purge_destructive',
        payload: { tool: 'purge_destructive', args: {} },
        payloadEncrypted: encrypt(JSON.stringify({ tool: 'purge_destructive', args: {} }), asService.encryptionKey),
        summary: 'purge_destructive requested by u-test',
        requestedBy: 'u-test',
        status: 'approved',
        decidedBy: 'U1',
        decidedAt: asService.now(),
        expiresAt: new Date(asService.now().getTime() + 24 * 3600 * 1000),
        idempotencyKey: 'test:purge_destructive:pre-level',
      })
      .returning();

    const serviceClient = await connectTools('approvals-test-service-fallback', replayableTools, asService);
    const res = await serviceClient.callTool({ name: 'approvals_execute', arguments: { approval_id: row.id } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('blocked by policy');
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('approved');
  });
});

describe('replaying a write to a principal own scope', () => {
  // `write.self` is auto at every level by default, so nothing parks it; a deployment whose
  // policy.yaml asks a human to sign off on memory writes is what reaches this path.
  const parksSelfWrites = mergePolicy(DEFAULT_POLICY, { classes: { 'write.self': 'approval' } });
  const selfWriteTools = [...memoryTools, ...approvalTools];

  /** Park a principal-scope `memory_add` as `u-test` and approve the row it produced. */
  async function parkSelfWrite(): Promise<string> {
    const requester = makeTestDeps(db, { policy: parksSelfWrites, encryptionKey: deps.encryptionKey });
    const client = await connectTools('approvals-test-self-write', selfWriteTools, requester);
    const res = await client.callTool({ name: 'memory_add', arguments: { text: 'Prefers bullet points.' } });
    const id = approvalIdOf(res);
    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, id));
    return id;
  }

  it('refuses the replay for anyone but the principal who asked, leaving the approval unspent', async () => {
    const id = await parkSelfWrite();
    // The replay runs on the approver's deps, and a `write.self` handler takes its owner from
    // them — so without the guard this would file the requester's note in the approver's memory.
    const approver = makeTestDeps(db, {
      principal: { ...TEST_PRINCIPAL, id: 'u-lead', level: 'lead', displayName: 'Lead' },
      policy: parksSelfWrites,
      encryptionKey: deps.encryptionKey,
    });
    const client = await connectTools('approvals-test-self-write-other', selfWriteTools, approver);
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('can only be approved by the principal who asked for it');
    expect(await db.select().from(memoryEntries)).toHaveLength(0);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('approved');
    expect(row.executedAt).toBeNull();
  });

  it('replays it for the principal who asked, into their own scope', async () => {
    const id = await parkSelfWrite();
    const requester = makeTestDeps(db, { policy: parksSelfWrites, encryptionKey: deps.encryptionKey });
    const client = await connectTools('approvals-test-self-write-owner', selfWriteTools, requester);
    const res = await client.callTool({ name: 'approvals_execute', arguments: { approval_id: id } });
    expect(resultOf<{ status: string }>(res).status).toBe('executed');
    const [entry] = await db.select().from(memoryEntries);
    expect(entry).toMatchObject({ scope: 'principal', principalId: 'u-test', createdBy: 'u-test' });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.status).toBe('executed');
  });
});

describe('parking an approval', () => {
  it('records the thread the call was made from', async () => {
    const [thread] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-test' })
      .returning();
    const threadDeps = makeTestDeps(db, { context: { threadId: thread.id } });
    const client = await connectTools('approvals-test-thread', replayableTools, threadDeps);
    const id = await park(client, { name: 'Dr. Threaded' });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.threadId).toBe(thread.id);
  });

  it('parks with a null thread outside a thread', async () => {
    const client = await connectApprovals();
    const id = await park(client, { name: 'Dr. Threadless' });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(row.threadId).toBeNull();
  });
});
