import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { approvals, auditLog, type Db } from '@harness/db';
import { defineTool, registerTools, ToolError } from './registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from './testing.js';

function textOf(res: { content: unknown }): string {
  const content = res.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? '';
}

const echo = defineTool({
  name: 'echo_read',
  description: 'Echo (read)',
  actionClass: 'read',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text }),
  recordIds: () => ['rec-1'],
});

const sendExternal = defineTool({
  name: 'send_external',
  description: 'Send something outside (external)',
  actionClass: 'external',
  input: z.object({ to: z.string() }),
  output: z.object({ sent: z.boolean() }),
  handler: async () => ({ sent: true }),
});

const pay = defineTool({
  name: 'pay',
  description: 'Move money (financial)',
  actionClass: 'financial',
  input: z.object({ amount: z.number() }),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

const boom = defineTool({
  name: 'boom',
  description: 'Always throws',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({}),
  handler: async () => {
    throw new Error('kaboom');
  },
});

const boomToolError = defineTool({
  name: 'boom_tool_error',
  description: 'Always throws a ToolError',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({}),
  handler: async () => {
    throw new ToolError('provider not found');
  },
});

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

function factory() {
  const server = new McpServer({ name: 'registry-test', version: '0.0.0' });
  registerTools(server, [echo, sendExternal, pay, boom, boomToolError], makeTestDeps(db));
  return server;
}

function factoryWithBrokenClock() {
  const server = new McpServer({ name: 'registry-test-broken-clock', version: '0.0.0' });
  registerTools(
    server,
    [sendExternal],
    makeTestDeps(db, {
      now: () => {
        throw new Error('clock down');
      },
    }),
  );
  return server;
}

describe('registerTools', () => {
  it('runs auto tools, returns ok envelope, audits with record ids', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 'hi' } });
    expect(res.structuredContent).toEqual({ status: 'ok', result: { text: 'hi' } });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'echo_read', decision: 'auto', recordIds: ['rec-1'], caller: 'test-caller' });
    await c();
  });

  it('parks approval-class tools and creates one approval row per identical request', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(first.structuredContent).toMatchObject({ status: 'pending' });
    expect(second.structuredContent).toEqual(first.structuredContent);
    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'send_external', status: 'pending', requestedBy: 'test-caller' });
    expect(rows[0].payload).toEqual({ tool: 'send_external', args: { to: 'payer@example.com' } });
    const audits = await db.select().from(auditLog);
    expect(audits.every((a) => a.decision === 'approval' && a.approvalId === rows[0].id)).toBe(true);
    await c();
  });

  it('blocks financial tools with isError and an audit row', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'pay', arguments: { amount: 5 } });
    expect(res.isError).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'pay', decision: 'blocked' });
    await c();
  });

  it('converts thrown errors into isError results and audits them, without leaking the raw message', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('kaboom');
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'boom', decision: 'error', error: 'kaboom' });
    await c();
  });

  it('surfaces the ToolError message to the caller for a ToolError, while still auditing it', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'boom_tool_error', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('provider not found');
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'boom_tool_error', decision: 'error', error: 'provider not found' });
    await c();
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 42 } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
    await c();
  });

  it('never throws out of the approval path and still audits when now() throws', async () => {
    const { client, close: c } = await makeTestClient(factoryWithBrokenClock);
    const res = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(approvals)).toHaveLength(0);
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'send_external', decision: 'error' });
    expect(rows[0].error).toContain('clock down');
    await c();
  });
});
