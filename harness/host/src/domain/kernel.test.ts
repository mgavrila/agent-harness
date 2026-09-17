import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, runs } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { testKernelConfig, useTestDb } from '../testing.js';
import { openKernel } from './kernel.js';

const db = useTestDb();
const LEAD: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: {},
  attributes: {},
};

describe('openKernel', () => {
  it('opens a run, serves the published tools to an in-process client on that run, and closes with a status', async () => {
    const host = { db, config: testKernelConfig(db), client: 'test', now: () => new Date('2026-09-15T12:00:00Z') };
    const kernel = await openKernel(host, {
      principal: LEAD,
      threadId: null,
      surface: 'memory',
      conversation: 'memory',
    });
    const { tools } = await kernel.client.listTools();
    expect(tools.map((t) => t.name)).toContain('documents_ingest');
    await kernel.client.callTool({ name: 'harness_reconcile', arguments: { stale_after_minutes: 10 } });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(row).toMatchObject({ caller: 'u-coordinator', runId: kernel.context.runId });
    expect(kernel.deps.principal).toBe(LEAD);
    await kernel.close('done');
    const [run] = await db.select().from(runs).where(eq(runs.id, kernel.context.runId));
    expect(run).toMatchObject({ status: 'done', surface: 'memory', conversation: 'memory' });
  });

  it('stamps the context it was given: a later skill activation lands on the same object', async () => {
    const host = { db, config: testKernelConfig(db), client: 'test', now: () => new Date() };
    const kernel = await openKernel(host, { principal: LEAD, threadId: null, surface: null, conversation: null });
    kernel.deps.context.skill = 'credentialing-roster';
    kernel.deps.context.skillVersion = '1.0.0';
    await kernel.client.callTool({ name: 'harness_reconcile', arguments: { stale_after_minutes: 10 } });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(row).toMatchObject({ skill: 'credentialing-roster', skillVersion: '1.0.0' });
    await kernel.close('done');
  });
});
