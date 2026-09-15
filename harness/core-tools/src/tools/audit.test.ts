import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, type Db } from '@harness/db';
import { type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { createCoreToolsServer } from '../server.js';

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

describe('audit_query', () => {
  it('lists prior tool calls newest first and filters by tool', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    await client.callTool({ name: 'providers_upsert', arguments: { name: 'Dr. X' } });
    const all = await client.callTool({ name: 'audit_query', arguments: {} });
    const entries = (all.structuredContent as { result: { entries: { tool: string; decision: string }[] } }).result.entries;
    // audit_query itself is audited after it returns, so it is not in its own result
    expect(entries.map((e) => e.tool)).toEqual(['providers_upsert', 'providers_search']);
    const filtered = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_upsert' } });
    expect((filtered.structuredContent as { result: { entries: unknown[] } }).result.entries).toHaveLength(1);
    await c();
  });

  it('reports that a call failed without returning the error text', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const failed = await client.callTool({ name: 'providers_get', arguments: { provider_id: randomUUID() } });
    expect(failed.isError).toBe(true);

    const res = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_get' } });
    const entries = (res.structuredContent as { result: { entries: Record<string, unknown>[] } }).result.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'providers_get', decision: 'error', has_error: true });
    expect(Object.keys(entries[0])).not.toContain('error');
    expect(JSON.stringify(entries[0])).not.toContain('not found');

    // The message is still recorded in the database for operators reading it with psql.
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'providers_get'));
    expect(rows[0].error).toContain('not found');
    await c();
  });

  it('marks a successful call as has_error false', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const res = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_search' } });
    const entries = (res.structuredContent as { result: { entries: Record<string, unknown>[] } }).result.entries;
    expect(entries[0]).toMatchObject({ decision: 'auto', has_error: false });
    await c();
  });

  // Rows sharing a created_at need a tiebreaker or the order is whatever the
  // heap returns. Asserting descending id proves the tiebreaker is applied.
  it('breaks ties on identical created_at by descending id', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const stamp = new Date('2026-09-15T12:00:00Z');
    for (const tool of ['a', 'b', 'c']) {
      await db.insert(auditLog).values({
        client: deps.client, caller: 'test', tool, actionClass: 'read', argsHash: 'h',
        decision: 'auto', createdAt: stamp,
      });
    }
    const res = await client.callTool({ name: 'audit_query', arguments: {} });
    const seeded = (res.structuredContent as { result: { entries: { id: string; tool: string }[] } }).result.entries
      .filter((e) => ['a', 'b', 'c'].includes(e.tool))
      .map((e) => e.id);
    expect(seeded).toHaveLength(3);
    expect(seeded).toEqual([...seeded].sort().reverse());
    await c();
  });

  it('server exposes all expected tools', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'approvals_execute',
      'audit_query',
      'deadlines_compute',
      'deadlines_upcoming',
      'harness_reconcile',
      'harness_set_context',
      'providers_confirm_field',
      'providers_get',
      'providers_list_pending',
      'providers_search',
      'providers_upsert',
    ]);
    await c();
  });
});
