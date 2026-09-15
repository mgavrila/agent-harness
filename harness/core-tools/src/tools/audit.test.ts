import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Db } from '@harness/db';
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

  it('server exposes all expected tools', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'audit_query',
      'deadlines_compute',
      'deadlines_upcoming',
      'providers_confirm_field',
      'providers_get',
      'providers_list_pending',
      'providers_search',
      'providers_upsert',
    ]);
    await c();
  });
});
