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
    expect(row).toMatchObject({ status: 'staged', sink: 'slack', idempotencyKey: 'test:roster:aetna', client: 'test', tool: 'send_roster' });
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

  it('scopes idempotency keys by client so two clients staging the same key do not collide', async () => {
    const otherDeps = makeTestDeps(db, { client: 'other-clinic' });
    const otherFactory = () => {
      const server = new McpServer({ name: 'effects-test-other', version: '0.0.0' });
      registerTools(server, [sendRoster], otherDeps);
      return server;
    };
    const { client, close: c } = await makeTestClient(factory);
    const { client: otherClient, close: otherClose } = await makeTestClient(otherFactory);

    const first = await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const second = await otherClient.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    expect((first.structuredContent as { result: { staged: boolean } }).result.staged).toBe(true);
    expect((second.structuredContent as { result: { staged: boolean } }).result.staged).toBe(true);

    const rows = await db.select().from(toolEffects);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(['other-clinic:roster:aetna', 'test:roster:aetna']);

    await c();
    await otherClose();
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

  it('stores what the sink returned on the dispatched row', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const seen: Array<{ tool: string; attempts: number; summary: string }> = [];
    const sinks: SinkRegistry = {
      slack: async (_payload, effect) => {
        seen.push({ tool: effect.tool, attempts: effect.attempts, summary: effect.summary });
        return { slack_ts: '1.2' };
      },
    };
    const r = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey });
    expect(r.dispatched).toBe(1);
    expect(seen).toEqual([{ tool: 'send_roster', attempts: 1, summary: 'Send aetna roster to Slack' }]);
    const [row] = await db.select().from(toolEffects);
    expect(row.result).toEqual({ slack_ts: '1.2' });
    await c();
  });

  it('leaves the result null when the sink returns nothing', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const r = await dispatchStagedEffects(db, { slack: async () => {} }, { key: deps.encryptionKey });
    expect(r.dispatched).toBe(1);
    const [row] = await db.select().from(toolEffects);
    expect(row.result).toBeNull();
    await c();
  });

  it('leaves a row alone when it changed state during dispatch, counting it conflicted', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'send_roster', arguments: { payer: 'aetna' } });
    const out = (res.structuredContent as { result: { effect_id: string } }).result;
    const sinks: SinkRegistry = {
      slack: async () => {
        await db.update(toolEffects).set({ status: 'cancelled' }).where(eq(toolEffects.id, out.effect_id));
        throw new Error('slack down');
      },
    };
    const r = await dispatchStagedEffects(db, sinks, { key: deps.encryptionKey });
    expect(r).toMatchObject({ conflicted: 1, retried: 0, failed: 0, dispatched: 0 });
    const [row] = await db.select().from(toolEffects).where(eq(toolEffects.id, out.effect_id));
    expect(row.status).toBe('cancelled');
    expect(row.attempts).toBe(1);
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
