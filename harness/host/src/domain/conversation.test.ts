import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, messages, runs, threads } from '@harness/db';
import { COORDINATOR, hostFixture, useTestDb } from '../testing.js';
import { UNAUTHORISED_TEXT, attachMessageHandlers, cancelRun } from './conversation.js';

const db = useTestDb();

describe('a message on a surface', () => {
  it('runs as the resolved principal, replies once on a surface without streaming, and records both turns', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ tool: 'harness_reconcile', args: { stale_after_minutes: 10 } }, { say: 'Nothing was stale.' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'Anything stale?');

    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: 'Nothing was stale.', replyTo: null }]);
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: 'u-coordinator',
      kind: 'chat',
    });
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(messages.createdAt);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'Anything stale?'],
      ['assistant', 'Nothing was stale.'],
    ]);
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({
      principalId: 'u-coordinator',
      threadId: thread.id,
      surface: 'memory',
      conversation: 'memory',
      status: 'done',
    });
    expect(rows.every((r) => r.runId === run.id)).toBe(true);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ caller: 'u-coordinator', runId: run.id });
    // The runtime was handed this run's kernel, the persona, the skills and the principal as the model user.
    const request = f.runtime.requests[0];
    expect(request.principal.id).toBe('u-coordinator');
    expect(request.model).toMatchObject({ route: 'chat', fallbackRoute: 'reason', user: 'u-coordinator' });
    expect(request.persona).toBe('You are the test assistant.');
    expect(request.skills.map((s) => s.name)).toEqual(['sample-skill']);
    expect(request.threadId).toBe(thread.id);
    expect(request.runId).toBe(run.id);
  });

  it('refuses a user the identity plug-in does not know, runs nothing, and audits the refusal', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U999', 'hello?');
    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: UNAUTHORISED_TEXT, replyTo: null }]);
    expect(f.runtime.requests).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(0);
    const [audit] = await db.select().from(auditLog);
    expect(audit).toMatchObject({ decision: 'unauthorised', caller: 'memory:U999', tool: 'host_message' });
  });

  it('stays silent in a group conversation unless mentioned', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'hi' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'chatter', { mentioned: false, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(0);
    await f.surface.say('U012', '@bot hi', { mentioned: true, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(1);
    expect(f.surface.texts[0]).toMatchObject({ conversation: 'C1', text: 'hi' });
  });

  it('streams when the surface can, and posts the withheld marker in place of a reply that trips the redaction check', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Part one.' }, { say: 'Part two.' }], streaming: true });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'go');
    expect(f.surface.streams).toEqual([
      { conversation: 'memory', text: 'Part one.Part two.', ended: true, replyTo: null },
    ]);
    expect(f.surface.texts).toHaveLength(1);

    const g = await hostFixture(db, { trajectory: [{ say: 'The SSN is 123-45-6789.' }] });
    attachMessageHandlers(g.host);
    await g.surface.say('U012', 'tell me');
    expect(g.surface.texts.at(-1)?.text).toBe('(withheld: it did not pass the redaction check)');
    const rows = await db.select().from(messages);
    expect(rows.some((r) => r.content.includes('123-45'))).toBe(false);
  });

  it('carries the prior turns of the thread as history, trimmed, and the attachments on the input', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }], budget: { maxHistoryMessages: 2 } });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'first');
    await f.surface.say('U012', 'second', { attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
    const request = f.runtime.requests[1];
    expect(request.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(request.input).toEqual({ text: 'second', attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
  });

  it('stamps the skill on the run context when the runtime activates one', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { skill: 'sample-skill', version: '1.0.0' },
        { tool: 'harness_reconcile', args: { stale_after_minutes: 10 } },
        { say: 'done' },
      ],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'roster please');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ skill: 'sample-skill', skillVersion: '1.0.0' });
  });

  it('parks an action for approval with the thread on the row, and the turn ends normally', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { tool: 'harness_notify', args: { text: 'roster ready', idempotency_key: 'roster:1' } },
        { say: 'It is waiting for approval.' },
      ],
      principals: [{ ...COORDINATOR, level: 'member' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'send the roster');
    const [parked] = await db.select().from(approvals);
    const [thread] = await db.select().from(threads);
    expect(parked).toMatchObject({ status: 'pending', requestedBy: 'u-coordinator', threadId: thread.id });
    expect(f.surface.texts.at(-1)?.text).toBe('It is waiting for approval.');
  });

  it('cancels a run in flight: no reply, status cancelled', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }, { say: 'never' }] });
    attachMessageHandlers(f.host);
    const turn = f.surface.say('U012', 'slow one');
    await new Promise((r) => setTimeout(r, 50));
    const [run] = await db.select().from(runs);
    expect(cancelRun(f.host, run.id)).toBe(true);
    await turn;
    expect(f.surface.texts).toEqual([]);
    const [after] = await db.select().from(runs);
    expect(after.status).toBe('cancelled');
    expect(f.host.active.size).toBe(0);
    expect(cancelRun(f.host, run.id)).toBe(false);
  });

  it('records an error status and tells the human once when the runtime fails', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }] });
    f.host.budget.timeoutMs = 20;
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'hang');
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(f.surface.texts).toHaveLength(1);
    expect(f.surface.texts[0].text).toContain('cancelled');
  });
});
