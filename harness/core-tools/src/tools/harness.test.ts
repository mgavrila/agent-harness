import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { auditLog, runs, type Db } from '@harness/db';
import { type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { createCoreToolsServer } from '../server.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
  deps = makeTestDeps(db);
});

describe('session context and lineage', () => {
  it('stamps run, skill, and version on later audit rows and creates the run row', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const runId = '11111111-1111-4111-8111-111111111111';
    await client.callTool({ name: 'harness_set_context', arguments: { run_id: runId, skill: 'credentialing-intake', skill_version: '1.0.0' } });
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const rows = await db.select().from(auditLog);
    const search = rows.find((r) => r.tool === 'providers_search')!;
    expect(search).toMatchObject({ runId, skill: 'credentialing-intake', skillVersion: '1.0.0' });
    expect(await db.select().from(runs)).toHaveLength(1);
    await c();
  });

  it('clears a field when null is passed', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    await client.callTool({ name: 'harness_set_context', arguments: { skill: 'x', skill_version: '1' } });
    await client.callTool({ name: 'harness_set_context', arguments: { skill: null } });
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
    expect(search.skill).toBeNull();
    expect(search.skillVersion).toBe('1');
    await c();
  });

  it('refuses to adopt a run that belongs to another client and leaves the context untouched', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const runId = '22222222-2222-4222-8222-222222222222';
    await db.insert(runs).values({ id: runId, client: 'other-clinic', caller: 'their-caller' });

    const res = await client.callTool({ name: 'harness_set_context', arguments: { run_id: runId } });
    expect(res.isError).toBe(true);
    expect(deps.context.runId).toBeUndefined();

    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
    expect(search.runId).toBeNull();
    await c();
  });

  it('stores derived_from on the audit row and strips it from handler args', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const first = await client.callTool({ name: 'providers_search', arguments: { query: 'a' } });
    expect(first.isError).toBeFalsy();
    const [firstAudit] = await db.select().from(auditLog);
    const second = await client.callTool({ name: 'providers_search', arguments: { query: 'b', derived_from: [firstAudit.id] } });
    expect(second.isError).toBeFalsy();
    const rows = await db.select().from(auditLog);
    const secondAudit = rows.find((r) => r.id !== firstAudit.id)!;
    expect(secondAudit.derivedFrom).toEqual([firstAudit.id]);
    const q = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_search' } });
    const entries = (q.structuredContent as { result: { entries: { id: string; derived_from: string[]; skill: string | null }[] } }).result.entries;
    expect(entries.find((e) => e.id === secondAudit.id)!.derived_from).toEqual([firstAudit.id]);
    await c();
  });
});
