import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, runs } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { TEST_PRINCIPAL, makeTestDeps } from '@harness/core-tools/testing';
import { pendingApproval, useTestDb } from '../../testing.js';
import { createInProcessCoreToolsClient } from './in-process.js';

const db = useTestDb();
const LEAD: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: {},
  attributes: {},
};
const HOST: Principal = {
  id: 'svc-host',
  kind: 'service',
  level: 'service',
  displayName: 'Host',
  surfaces: {},
  attributes: {},
};

/** The startup-only half of a test bag: what `buildKernelConfig` would have built. */
function config() {
  const {
    db: _db,
    principal: _p,
    context: _c,
    sinks: _s,
    tools: _t,
    kernelTools: _k,
    kernel: _kn,
    ...rest
  } = makeTestDeps(db);
  return rest;
}

describe('createInProcessCoreToolsClient', () => {
  it('executes an approved action as the approver, in a run of its own, and audits it under that principal', async () => {
    const client = createInProcessCoreToolsClient({ db, config: config(), client: 'test', servicePrincipal: HOST });
    const [row] = await db
      .insert(approvals)
      .values(
        pendingApproval({
          client: 'test',
          action: 'harness_notify',
          status: 'approved',
          requestedBy: TEST_PRINCIPAL.id,
          payloadEncrypted: null,
        }),
      )
      .returning();
    // No payload to replay: the kernel refuses, which is enough to prove the route and the principal.
    const outcome = await client.execute(row.id, LEAD);
    expect(outcome.status).toBe('failed');
    const audit = await db.select().from(auditLog).where(eq(auditLog.tool, 'approvals_execute'));
    expect(audit).toHaveLength(1);
    expect(audit[0].caller).toBe('u-coordinator');
    const [run] = await db.select().from(runs).where(eq(runs.id, audit[0].runId!));
    expect(run).toMatchObject({ principalId: 'u-coordinator', status: 'done' });
    await client.close();
  });

  it('reconciles as the service principal', async () => {
    const client = createInProcessCoreToolsClient({ db, config: config(), client: 'test', servicePrincipal: HOST });
    expect(await client.reconcile(10)).toEqual({ approvals_expired: 0, dispatches_parked: 0 });
    const audit = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit[0].caller).toBe('svc-host');
    await client.close();
  });
});
