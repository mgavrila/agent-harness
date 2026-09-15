import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { deadlines, type Db } from '@harness/db';
import { registerTools, type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { providerTools } from './providers.js';
import { deadlineTools } from './deadlines.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db, { now: () => new Date('2026-09-15T12:00:00Z') });
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

const factory = () => {
  const server = new McpServer({ name: 'deadlines-test', version: '0.0.0' });
  registerTools(server, [...providerTools, ...deadlineTools], deps);
  return server;
};

async function seed(client: Awaited<ReturnType<typeof makeTestClient>>['client']) {
  const res = await client.callTool({
    name: 'providers_upsert',
    arguments: {
      name: 'Dr. Grace Hopper',
      npi: '1112223334',
      credentials: [
        { kind: 'license', state: 'NY', number: 'L1', expires_at: '2026-10-15' },
        { kind: 'dea', number: 'D1', expires_at: '2027-06-30' },
        { kind: 'malpractice', number: 'M1', expires_at: '2026-09-01' },
      ],
    },
  });
  return (res.structuredContent as { result: { provider_id: string } }).result.provider_id;
}

describe('deadlines tools', () => {
  it('compute writes one row per credential and kind, idempotently', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    const first = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect((first.structuredContent as { result: { deadlines: unknown[] } }).result.deadlines).toHaveLength(6);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect(await db.select().from(deadlines)).toHaveLength(6);
    await c();
  });

  it('compute rejects an unknown provider', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: randomUUID() } });
    expect(res.isError).toBe(true);
    await c();
  });

  it('upcoming returns items inside the window, flags overdue, sorted by due date', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    const items = (res.structuredContent as { result: { items: { credential_kind: string; kind: string; due_at: string; days_left: number; overdue: boolean; provider_name: string }[] } }).result.items;
    // today 2026-09-15: malpractice expiration 09-01 (overdue), malpractice renewal_start 07-03 (overdue),
    // license renewal_start 07-17 (overdue), license expiration 10-15 (30 days). DEA (2027-06-30, renewal 2027-04-01) is outside.
    expect(items.map((i) => `${i.credential_kind}:${i.kind}`)).toEqual([
      'malpractice:renewal_start',
      'license:renewal_start',
      'malpractice:expiration',
      'license:expiration',
    ]);
    expect(items[0].overdue).toBe(true);
    expect(items[3]).toMatchObject({ days_left: 30, overdue: false, provider_name: 'Dr. Grace Hopper' });
    await c();
  });

  it('upcoming accepts an explicit today', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 30, today: '2027-06-15' } });
    const items = (res.structuredContent as { result: { items: { credential_kind: string; kind: string }[] } }).result.items;
    expect(items.some((i) => i.credential_kind === 'dea' && i.kind === 'expiration')).toBe(true);
    await c();
  });
});
