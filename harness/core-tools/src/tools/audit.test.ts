import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog } from '@harness/db';
import { connectTestClient, makeTestDeps, resultOf, useTestDb } from '../testing.js';
import { createCoreToolsServer } from './catalog.js';

const db = useTestDb();
const deps = makeTestDeps(db);

const connectServer = () => connectTestClient(() => createCoreToolsServer(deps));

/** One row of `audit_query`'s result, as far as these tests look at it. */
interface AuditEntry {
  id: string;
  tool: string;
  decision: string;
  has_error: boolean;
}

describe('audit_query', () => {
  it('lists prior tool calls newest first and filters by tool', async () => {
    const client = await connectServer();
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    await client.callTool({ name: 'providers_upsert', arguments: { name: 'Dr. X' } });
    const all = await client.callTool({ name: 'audit_query', arguments: {} });
    const { entries } = resultOf<{ entries: AuditEntry[] }>(all);
    // audit_query itself is audited after it returns, so it is not in its own result
    expect(entries.map((e) => e.tool)).toEqual(['providers_upsert', 'providers_search']);
    const filtered = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_upsert' } });
    expect(resultOf<{ entries: AuditEntry[] }>(filtered).entries).toHaveLength(1);
  });

  it('reports that a call failed without returning the error text', async () => {
    const client = await connectServer();
    const failed = await client.callTool({ name: 'providers_get', arguments: { provider_id: randomUUID() } });
    expect(failed.isError).toBe(true);

    const res = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_get' } });
    const { entries } = resultOf<{ entries: AuditEntry[] }>(res);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'providers_get', decision: 'error', has_error: true });
    expect(Object.keys(entries[0])).not.toContain('error');
    expect(JSON.stringify(entries[0])).not.toContain('not found');

    // The message is still recorded in the database for operators reading it with psql.
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'providers_get'));
    expect(rows[0].error).toContain('not found');
  });

  it('marks a successful call as has_error false', async () => {
    const client = await connectServer();
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const res = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_search' } });
    const { entries } = resultOf<{ entries: AuditEntry[] }>(res);
    expect(entries[0]).toMatchObject({ decision: 'auto', has_error: false });
  });

  // Rows sharing a created_at need a tiebreaker or the order is whatever the
  // heap returns. Asserting descending id proves the tiebreaker is applied.
  it('breaks ties on identical created_at by descending id', async () => {
    const client = await connectServer();
    const stamp = new Date('2026-09-15T12:00:00Z');
    for (const tool of ['a', 'b', 'c']) {
      await db.insert(auditLog).values({
        client: deps.client,
        caller: 'test',
        tool,
        actionClass: 'read',
        argsHash: 'h',
        decision: 'auto',
        createdAt: stamp,
      });
    }
    const res = await client.callTool({ name: 'audit_query', arguments: {} });
    const seeded = resultOf<{ entries: AuditEntry[] }>(res)
      .entries.filter((e) => ['a', 'b', 'c'].includes(e.tool))
      .map((e) => e.id);
    expect(seeded).toHaveLength(3);
    expect(seeded).toEqual([...seeded].sort().reverse());
  });

  it('server exposes all expected tools', async () => {
    const client = await connectServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'approvals_execute',
      'audit_query',
      'deadlines_compute',
      'deadlines_upcoming',
      'documents_classify',
      'documents_extract',
      'documents_get',
      'documents_ingest',
      'documents_list',
      'forms_fill',
      'forms_list_templates',
      'forms_release',
      'forms_roster',
      'harness_notify',
      'harness_reconcile',
      'memory_add',
      'memory_list',
      'memory_remove',
      'playbooks_list',
      'playbooks_run_now',
      'providers_confirm_field',
      'providers_get',
      'providers_list_pending',
      'providers_search',
      'providers_upsert',
      'session_search',
      'verify_nppes',
      'verify_state_license',
    ]);
  });
});
