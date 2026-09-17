import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, runs, toolEffects } from '@harness/db';
import { type ToolDeps } from '../domain/tooling/types.js';
import { connectTestClient, makeTestDeps, resultOf, useTestDb } from '../testing.js';
import { createCoreToolsServer } from './catalog.js';

const db = useTestDb();
let deps: ToolDeps;

// Fresh deps per test: these tests assert on the session context these tools mutate.
beforeEach(() => {
  deps = makeTestDeps(db);
});

const connectServer = () => connectTestClient(() => createCoreToolsServer(deps));

describe('session context and lineage', () => {
  it('stamps run, skill, and version on later audit rows and creates the run row', async () => {
    const client = await connectServer();
    const runId = '11111111-1111-4111-8111-111111111111';
    await client.callTool({
      name: 'harness_set_context',
      arguments: { run_id: runId, skill: 'credentialing-intake', skill_version: '1.0.0' },
    });
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const rows = await db.select().from(auditLog);
    const search = rows.find((r) => r.tool === 'providers_search')!;
    expect(search).toMatchObject({ runId, skill: 'credentialing-intake', skillVersion: '1.0.0' });
    expect(await db.select().from(runs)).toHaveLength(1);
  });

  it('clears a field when null is passed', async () => {
    const client = await connectServer();
    await client.callTool({ name: 'harness_set_context', arguments: { skill: 'x', skill_version: '1' } });
    await client.callTool({ name: 'harness_set_context', arguments: { skill: null } });
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
    expect(search.skill).toBeNull();
    expect(search.skillVersion).toBe('1');
  });

  it('refuses to adopt a run that belongs to another client and leaves the context untouched', async () => {
    const client = await connectServer();
    const runId = '22222222-2222-4222-8222-222222222222';
    await db
      .insert(runs)
      .values({ id: runId, client: 'other-clinic', caller: 'their-caller', principalId: 'their-caller' });

    const res = await client.callTool({ name: 'harness_set_context', arguments: { run_id: runId } });
    expect(res.isError).toBe(true);
    expect(deps.context.runId).toBeNull();

    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
    expect(search.runId).toBeNull();
  });

  it('stores derived_from on the audit row and strips it from handler args', async () => {
    const client = await connectServer();
    const first = await client.callTool({ name: 'providers_search', arguments: { query: 'a' } });
    expect(first.isError).toBeFalsy();
    const [firstAudit] = await db.select().from(auditLog);
    const second = await client.callTool({
      name: 'providers_search',
      arguments: { query: 'b', derived_from: [firstAudit.id] },
    });
    expect(second.isError).toBeFalsy();
    const rows = await db.select().from(auditLog);
    const secondAudit = rows.find((r) => r.id !== firstAudit.id)!;
    expect(secondAudit.derivedFrom).toEqual([firstAudit.id]);
    const q = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_search' } });
    const { entries } = resultOf<{ entries: { id: string; derived_from: string[] }[] }>(q);
    expect(entries.find((e) => e.id === secondAudit.id)!.derived_from).toEqual([firstAudit.id]);
  });

  it('stages a surface_message effect instead of sending', async () => {
    const client = await connectServer();
    const out = resultOf<{ effect_id: string; staged: boolean }>(
      await client.callTool({
        name: 'harness_notify',
        arguments: { text: '2 credentials expire within 90 days.', idempotency_key: 'expirations:2026-09-15' },
      }),
    );
    expect(out.staged).toBe(true);
    const [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ sink: 'surface_message', tool: 'harness_notify', status: 'staged', client: 'test' });
    expect(row.idempotencyKey).toBe('test:expirations:2026-09-15');
    // The text is the payload, which is encrypted; the summary is a label.
    expect(row.payloadEncrypted.toString('utf8')).not.toContain('expire within 90 days');
    expect(row.summary).not.toContain('expire within 90 days');
  });

  it('addresses the effect to a named surface and conversation when the caller gives them', async () => {
    const client = await connectServer();
    await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-addressed', channel: 'memory', surface: 'memory' },
    });
    const [row] = await db.select().from(toolEffects);
    expect(row.sink).toBe('surface_message');
    // The payload is encrypted; what an operator can read is the sink and the summary.
    expect(row.summary).toBe('Message (8 characters)');
  });

  it('refuses a conversation id that is not a bare identifier', async () => {
    const client = await connectServer();
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-bad', channel: 'not a channel' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('stages the same digest once', async () => {
    const client = await connectServer();
    const args = { text: 'one item', idempotency_key: 'expirations:2026-09-15' };
    await client.callTool({ name: 'harness_notify', arguments: args });
    const second = resultOf<{ staged: boolean }>(await client.callTool({ name: 'harness_notify', arguments: args }));
    expect(second.staged).toBe(false);
    expect(await db.select().from(toolEffects)).toHaveLength(1);
  });

  it('refuses a message that looks like it carries a restricted identifier', async () => {
    const client = await connectServer();
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'Dr. Reyes SSN 123-45-6789 is on file', idempotency_key: 'x' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('refuses a conversation id that looks like a restricted identifier', async () => {
    const client = await connectServer();
    // `CONVERSATION_ID_PATTERN` admits this, because the kernel cannot know a surface's id
    // format. Nothing downstream would catch it: the id is stored in plaintext, and the adapter
    // that rejects it writes its complaint into the plaintext `tool_effects.last_error`.
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-ssn-channel', channel: '123-45-6789' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('refuses a surface name that looks like a restricted identifier', async () => {
    const client = await connectServer();
    // A DEA registration is two letters and seven digits, which `SURFACE_NAME_PATTERN` accepts.
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-dea-surface', surface: 'ab1234567' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('records the lineage the caller declares', async () => {
    const client = await connectServer();
    const [earlier] = await db
      .insert(auditLog)
      .values({
        client: 'test',
        caller: 'test-caller',
        tool: 'deadlines_upcoming',
        actionClass: 'read',
        argsHash: 'h',
        decision: 'auto',
      })
      .returning();
    await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k', derived_from: [earlier.id] },
    });
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_notify'));
    expect(rows[0].derivedFrom).toEqual([earlier.id]);
  });
});
