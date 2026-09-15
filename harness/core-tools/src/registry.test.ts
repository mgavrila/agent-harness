import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, decrypt, type Db } from '@harness/db';
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

const sendExternalRedacted = defineTool({
  name: 'send_external_redacted',
  description: 'Send something outside, redacting the recipient in the stored payload',
  actionClass: 'external',
  input: z.object({ to: z.string(), note: z.string() }),
  output: z.object({ sent: z.boolean() }),
  handler: async () => ({ sent: true }),
  redact: (a) => ({ ...a, to: '[restricted]' }),
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

  it('does not reuse a decided approval: a new request parks a fresh pending row', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const firstId = (first.structuredContent as { approval_id: string }).approval_id;
    await db.update(approvals).set({ status: 'declined', decidedBy: 'U1' }).where(eq(approvals.id, firstId));

    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const secondId = (second.structuredContent as { status: string; approval_id: string }).approval_id;
    expect((second.structuredContent as { status: string }).status).toBe('pending');
    expect(secondId).not.toBe(firstId);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === firstId)!.status).toBe('declined');
    expect(rows.find((r) => r.id === secondId)!.status).toBe('pending');
    await c();
  });

  it('expires a stale pending approval and parks a new one', async () => {
    const shortTtl = makeTestDeps(db, { approvalTtlHours: 1 });
    const { client, close: c } = await makeTestClient(() => {
      const server = new McpServer({ name: 'registry-test-ttl', version: '0.0.0' });
      registerTools(server, [sendExternal], shortTtl);
      return server;
    });
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const firstId = (first.structuredContent as { approval_id: string }).approval_id;
    await c();

    const later = makeTestDeps(db, { approvalTtlHours: 1, now: () => new Date('2026-09-15T14:00:00Z') });
    const { client: client2, close: c2 } = await makeTestClient(() => {
      const server = new McpServer({ name: 'registry-test-ttl-later', version: '0.0.0' });
      registerTools(server, [sendExternal], later);
      return server;
    });
    const second = await client2.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const secondId = (second.structuredContent as { approval_id: string }).approval_id;
    expect(secondId).not.toBe(firstId);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(2);
    const expired = rows.find((r) => r.id === firstId)!;
    expect(expired.status).toBe('expired');
    expect(expired.decidedAt).not.toBeNull();
    expect(rows.find((r) => r.id === secondId)!.status).toBe('pending');
    await c2();
  });

  it('reuses a live pending approval rather than parking a duplicate', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(await db.select().from(approvals)).toHaveLength(1);
    await c();
  });

  it('stores a redacted approval payload and the full args encrypted', async () => {
    const deps = makeTestDeps(db);
    const { client, close: c } = await makeTestClient(() => {
      const server = new McpServer({ name: 'registry-test-redact', version: '0.0.0' });
      registerTools(server, [sendExternalRedacted], deps);
      return server;
    });
    await client.callTool({ name: 'send_external_redacted', arguments: { to: 'ssn-999-88-7777', note: 'keep me' } });

    const [row] = await db.select().from(approvals);
    expect(row.payload).toEqual({
      tool: 'send_external_redacted',
      args: { to: '[restricted]', note: 'keep me' },
    });
    expect(row.payloadEncrypted).not.toBeNull();
    expect(JSON.parse(decrypt(row.payloadEncrypted!, deps.encryptionKey))).toEqual({
      tool: 'send_external_redacted',
      args: { to: 'ssn-999-88-7777', note: 'keep me' },
    });
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
