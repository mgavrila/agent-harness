import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, playbookRuns, playbooks } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { TEST_PRINCIPAL, connectTestClient, makeTestDeps, resultOf, textOf, useTestDb } from '../testing.js';
import { createCoreToolsServer } from './catalog.js';

const db = useTestDb();
const ADMIN: Principal = { ...TEST_PRINCIPAL, id: 'u-practice-manager', level: 'admin', displayName: 'Manager' };

const connectAs = (principal: Principal) =>
  connectTestClient(() => createCoreToolsServer(makeTestDeps(db, { principal })));

async function seed(name: string, enabled = true) {
  const [row] = await db
    .insert(playbooks)
    .values({
      client: 'test',
      name,
      schedule: '0 7 * * *',
      skill: 'a-skill',
      prompt: 'run it',
      principalId: 'svc-playbooks',
      costCapUsd: 0.5,
      enabled,
      nextRunAt: enabled ? new Date('2026-09-16T07:00:00Z') : null,
    })
    .returning();
  return row;
}

describe('playbook tools', () => {
  it('lists the client playbooks for anyone who can read, without the prompt', async () => {
    await seed('nightly');
    await seed('weekly', false);
    const client = await connectAs(TEST_PRINCIPAL);
    const { playbooks: listed } = resultOf<{ playbooks: Record<string, unknown>[] }>(
      await client.callTool({ name: 'playbooks_list', arguments: {} }),
    );
    expect(listed.map((p) => [p.name, p.enabled, p.next_run_at])).toEqual([
      ['nightly', true, '2026-09-16T07:00:00.000Z'],
      ['weekly', false, null],
    ]);
    expect(listed[0]).not.toHaveProperty('prompt');
  });

  it('never carries a timezone: the schedule runs in UTC', async () => {
    await seed('nightly');
    const client = await connectAs(TEST_PRINCIPAL);
    const { playbooks: listed } = resultOf<{ playbooks: Record<string, unknown>[] }>(
      await client.callTool({ name: 'playbooks_list', arguments: {} }),
    );
    expect(listed[0]).not.toHaveProperty('timezone');
  });

  it('lets an admin request a run now, stamped with who asked, and blocks everyone else', async () => {
    const playbook = await seed('nightly');
    const admin = await connectAs(ADMIN);
    const requested = resultOf<{ playbook_run_id: string; status: string }>(
      await admin.callTool({ name: 'playbooks_run_now', arguments: { name: 'nightly' } }),
    );
    expect(requested.status).toBe('requested');
    const [row] = await db.select().from(playbookRuns);
    expect(row).toMatchObject({
      id: requested.playbook_run_id,
      playbookId: playbook.id,
      status: 'requested',
      requestedBy: 'u-practice-manager',
    });
    expect(row.scheduledAt.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'playbooks_run_now'));
    expect(audit).toMatchObject({ actionClass: 'admin', decision: 'auto', caller: 'u-practice-manager' });

    const lead = await connectAs({ ...TEST_PRINCIPAL, level: 'lead' });
    const blocked = await lead.callTool({ name: 'playbooks_run_now', arguments: { name: 'nightly' } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain('blocked by policy');
    expect(await db.select().from(playbookRuns)).toHaveLength(1);
  });

  it('refuses an unknown or disabled playbook', async () => {
    await seed('weekly', false);
    const admin = await connectAs(ADMIN);
    const missing = await admin.callTool({ name: 'playbooks_run_now', arguments: { name: 'nightly' } });
    expect(textOf(missing)).toContain('no playbook named "nightly"');
    const disabled = await admin.callTool({ name: 'playbooks_run_now', arguments: { name: 'weekly' } });
    expect(textOf(disabled)).toContain('playbook "weekly" is disabled');
    expect(await db.select().from(playbookRuns)).toHaveLength(0);
  });
});
