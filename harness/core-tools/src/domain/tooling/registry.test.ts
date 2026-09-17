import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, decrypt, records } from '@harness/db';
import { ToolError } from '@harness/shared';
import { TEST_PRINCIPAL, approvalIdOf, connectTools, makeTestDeps, textOf, useTestDb } from '../../testing.js';
import { defineTool } from './registry.js';

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

const purge = defineTool({
  name: 'purge',
  description: 'Delete beyond repair (destructive)',
  actionClass: 'destructive',
  input: z.object({}),
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

const writeThenThrow = defineTool({
  name: 'write_then_throw',
  description: 'Inserts a provider row then throws (auto class)',
  actionClass: 'write.internal',
  input: z.object({ name: z.string() }),
  output: z.object({}),
  handler: async ({ name }, deps) => {
    await deps.db.insert(records).values({ client: deps.client, pack: 'healthcare', kind: 'provider', name });
    throw new ToolError('rolled back on purpose');
  },
});

const writeOk = defineTool({
  name: 'write_ok',
  description: 'Inserts a provider row (auto class)',
  actionClass: 'write.internal',
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ name }, deps) => {
    await deps.db.insert(records).values({ client: deps.client, pack: 'healthcare', kind: 'provider', name });
    return { ok: true };
  },
});

const db = useTestDb();

const allTools = [echo, sendExternal, pay, boom, boomToolError, writeThenThrow, writeOk];

/** A client over the whole fixture set, with fresh default deps. */
const connectDefault = () => connectTools('registry-test', allTools, makeTestDeps(db));

describe('registerTools', () => {
  it('runs auto tools, returns ok envelope, audits with record ids', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 'hi' } });
    expect(res.structuredContent).toEqual({ status: 'ok', result: { text: 'hi' } });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'echo_read', decision: 'auto', recordIds: ['rec-1'], caller: 'u-test' });
  });

  it('parks approval-class tools and creates one approval row per identical request', async () => {
    const client = await connectDefault();
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(first.structuredContent).toMatchObject({ status: 'pending' });
    expect(second.structuredContent).toEqual(first.structuredContent);
    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'send_external', status: 'pending', requestedBy: 'u-test' });
    expect(rows[0].payload).toEqual({ tool: 'send_external', args: { to: 'payer@example.com' } });
    const audits = await db.select().from(auditLog);
    expect(audits.every((a) => a.decision === 'approval' && a.approvalId === rows[0].id)).toBe(true);
  });

  it('blocks financial tools with isError and an audit row', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'pay', arguments: { amount: 5 } });
    expect(res.isError).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'pay', decision: 'blocked' });
  });

  it('decides by the principal level: a member is parked on an internal write and a service is refused a destructive one', async () => {
    const asMember = makeTestDeps(db, { principal: { ...TEST_PRINCIPAL, id: 'u-member', level: 'member' } });
    const member = await connectTools('registry-test-member', [writeOk], asMember);
    const parked = await member.callTool({ name: 'write_ok', arguments: { name: 'Dr. Parked' } });
    expect(parked.structuredContent).toMatchObject({ status: 'pending' });
    expect(await db.select().from(records)).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row.requestedBy).toBe('u-member');

    const asService = makeTestDeps(db, {
      principal: { ...TEST_PRINCIPAL, id: 'svc-nightly', kind: 'service', level: 'service' },
    });
    const service = await connectTools('registry-test-service', [purge], asService);
    const refused = await service.callTool({ name: 'purge', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('blocked by policy');
    const audits = await db.select().from(auditLog).where(eq(auditLog.tool, 'purge'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'blocked', caller: 'svc-nightly' });
  });

  it('converts thrown errors into isError results and audits them, without leaking the raw message', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('kaboom');
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'boom', decision: 'error', error: 'kaboom' });
  });

  it('surfaces the ToolError message to the caller for a ToolError, while still auditing it', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'boom_tool_error', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('provider not found');
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'boom_tool_error', decision: 'error', error: 'provider not found' });
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 42 } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('does not reuse a decided approval: a new request parks a fresh pending row', async () => {
    const client = await connectDefault();
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const firstId = approvalIdOf(first);
    await db.update(approvals).set({ status: 'declined', decidedBy: 'U1' }).where(eq(approvals.id, firstId));

    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const secondId = approvalIdOf(second);
    expect(second.structuredContent).toMatchObject({ status: 'pending' });
    expect(secondId).not.toBe(firstId);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === firstId)!.status).toBe('declined');
    expect(rows.find((r) => r.id === secondId)!.status).toBe('pending');
  });

  it('expires a stale pending approval and parks a new one', async () => {
    const shortTtl = makeTestDeps(db, { approvalTtlHours: 1 });
    const client = await connectTools('registry-test-ttl', [sendExternal], shortTtl);
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const firstId = approvalIdOf(first);

    const later = makeTestDeps(db, { approvalTtlHours: 1, now: () => new Date('2026-09-15T14:00:00Z') });
    const client2 = await connectTools('registry-test-ttl-later', [sendExternal], later);
    const second = await client2.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const secondId = approvalIdOf(second);
    expect(secondId).not.toBe(firstId);

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(2);
    const expired = rows.find((r) => r.id === firstId)!;
    expect(expired.status).toBe('expired');
    expect(expired.decidedAt).not.toBeNull();
    expect(rows.find((r) => r.id === secondId)!.status).toBe('pending');
  });

  it('reuses a live pending approval rather than parking a duplicate', async () => {
    const client = await connectDefault();
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it('stores a redacted approval payload and the full args encrypted', async () => {
    const deps = makeTestDeps(db);
    const client = await connectTools('registry-test-redact', [sendExternalRedacted], deps);
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
  });

  it('never throws out of the approval path and still audits when now() throws', async () => {
    const brokenClock = makeTestDeps(db, {
      now: () => {
        throw new Error('clock down');
      },
    });
    const client = await connectTools('registry-test-broken-clock', [sendExternal], brokenClock);
    const res = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(approvals)).toHaveLength(0);
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'send_external', decision: 'error' });
    expect(rows[0].error).toContain('clock down');
  });

  it('rolls back handler writes when the handler throws, and still audits the error', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'write_then_throw', arguments: { name: 'Dr. Rollback' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('rolled back on purpose');
    expect(await db.select().from(records)).toHaveLength(0);
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: 'write_then_throw', decision: 'error', error: 'rolled back on purpose' });
  });

  it('commits handler writes together with the audit row', async () => {
    const client = await connectDefault();
    const res = await client.callTool({ name: 'write_ok', arguments: { name: 'Dr. Commit' } });
    expect(res.structuredContent).toEqual({ status: 'ok', result: { ok: true } });
    expect(await db.select().from(records)).toHaveLength(1);
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: 'write_ok', decision: 'auto' });
  });

  it('rolls the parked approval back when the audit write in the same transaction fails', async () => {
    // A run id with no `runs` row makes the audit insert violate audit_log's
    // run_id foreign key, which is the only way to fail the write after the
    // approval row is already inserted in the same transaction.
    const deps = makeTestDeps(db, { context: { runId: randomUUID() } });
    const client = await connectTools('registry-test-approval-atomicity', [sendExternal], deps);

    const res = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });
});
