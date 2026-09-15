import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { toolEffects, type Db } from '@harness/db';
import { defineTool, registerTools, type ToolDeps } from './registry.js';
import { stageEffect, dispatchStagedEffects, type SinkRegistry } from './effects.js';
import { makeTestDeps, makeTestClient, openTestDb } from './testing.js';

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

const sendRoster = defineTool({
  name: 'send_roster',
  description: 'Stages a Slack file effect (auto class in tests)',
  actionClass: 'write.internal',
  input: z.object({ payer: z.string(), fail_after_stage: z.boolean().default(false) }),
  output: z.object({ effect_id: z.string(), staged: z.boolean() }),
  handler: async ({ payer, fail_after_stage }, d) => {
    const out = await stageEffect(d, {
      sink: 'slack',
      idempotencyKey: `roster:${payer}`,
      payload: { payer, ssn: '123-45-6789' },
      summary: `Send ${payer} roster to Slack`,
    });
    if (fail_after_stage) throw new Error('boom after stage');
    return out;
  },
});

const factory = () => {
  const server = new McpServer({ name: 'effects-test', version: '0.0.0' });
  registerTools(server, [sendRoster], deps);
  return server;
};

describe('effects outbox', () => {
  it('stages an effect inside the tool transaction, encrypted, with status staged', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const out = (res.structuredContent as { result: { effect_id: string; staged: boolean } }).result;
    expect(out.staged).toBe(true);
    const [row] = await db.select().from(toolEffects).where(eq(toolEffects.id, out.effect_id));
    expect(row).toMatchObject({ status: 'staged', sink: 'slack', idempotencyKey: 'roster:aetna', client: 'test', tool: 'send_roster' });
    expect(row.payloadEncrypted.toString()).not.toContain('123-45-6789');
    await c();
  });

  it('does not keep a staged effect when the handler throws after staging', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna', fail_after_stage: true } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
    await c();
  });

  it('staging the same key twice keeps one row and reports staged: false', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const second = await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    expect((second.structuredContent as { result: { staged: boolean } }).result.staged).toBe(false);
    expect(await db.select().from(toolEffects)).toHaveLength(1);
    await c();
  });

  it('dispatches once with the decrypted payload, never twice', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const calls: unknown[] = [];
    const sinks: SinkRegistry = { slack: async (payload) => { calls.push(payload); } };
    const first = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey });
    expect(first).toMatchObject({ dispatched: 1, failed: 0, retried: 0 });
    expect(calls).toEqual([{ payer: 'aetna', ssn: '123-45-6789' }]);
    const again = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey });
    expect(again.dispatched).toBe(0);
    expect(calls).toHaveLength(1);
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('dispatched');
    expect(row.dispatchedAt).not.toBeNull();
    await c();
  });

  it('retries a failing sink up to maxAttempts, then marks failed', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const sinks: SinkRegistry = { slack: async () => { throw new Error('slack down'); } };
    const r1 = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey, maxAttempts: 2 });
    expect(r1).toMatchObject({ retried: 1, failed: 0 });
    let [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ status: 'staged', attempts: 1, lastError: 'slack down' });
    const r2 = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey, maxAttempts: 2 });
    expect(r2).toMatchObject({ retried: 0, failed: 1 });
    [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
    await c();
  });

  it('skips effects whose sink is not registered and leaves them staged', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const r = await dispatchStagedEffects(db, {}, { key: deps.encryptionKey });
    expect(r).toMatchObject({ skipped: 1, dispatched: 0 });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    await c();
  });
});
