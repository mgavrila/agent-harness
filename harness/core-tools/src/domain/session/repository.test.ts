import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelCalls, runs } from '@harness/db';
import { TEST_PRINCIPAL, useTestDb } from '../../testing.js';
import { closeRun, finishRun, openRun, sumRunTotals } from './repository.js';

const db = useTestDb();

describe('openRun', () => {
  it('writes the runs row with the principal id and hands back the context every audit row will carry', async () => {
    const context = await openRun(db, {
      client: 'test',
      principal: TEST_PRINCIPAL,
      surface: 'memory',
      conversation: 'memory',
    });
    expect(context).toEqual({ runId: expect.any(String), threadId: null, surface: 'memory', conversation: 'memory' });
    const [row] = await db.select().from(runs);
    expect(row).toMatchObject({
      id: context.runId,
      client: 'test',
      principalId: 'u-test',
      threadId: null,
      surface: 'memory',
      conversation: 'memory',
      status: 'running',
    });
    expect('caller' in row).toBe(false);
  });

  it('defaults the addressing to null for a run with no surface, and reuses an id it is given', async () => {
    const first = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    expect(first).toMatchObject({ threadId: null, surface: null, conversation: null });
    // What the eval pipeline does after `resetDatabase` truncated the row: the same id, so an
    // already-built ToolDeps keeps pointing at a run that exists.
    await db.delete(runs);
    const again = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL, id: first.runId });
    expect(again.runId).toBe(first.runId);
    expect(await db.select().from(runs)).toHaveLength(1);
  });

  it('closes a run with its status and end time', async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL, threadId: null });
    await closeRun(db, 'test', context.runId, 'cancelled', () => new Date('2026-09-15T12:30:00Z'));
    const [row] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(row.status).toBe('cancelled');
    expect(row.endedAt?.toISOString()).toBe('2026-09-15T12:30:00.000Z');
    expect(row.principalId).toBe('u-test');
  });

  it("closes a run with what it spent, summed from that run's own calls", async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    const other = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    for (const [runId, inputTokens] of [
      [context.runId, 100],
      [context.runId, 50],
      [other.runId, 9_000],
    ] as const) {
      await db
        .insert(modelCalls)
        .values({ runId, client: 'test', route: 'extract', model: 'm', inputTokens, outputTokens: 1, costUsd: 0.01 });
    }
    // Another tenant's row on this run id moves nothing: every query carries the client.
    await db.insert(modelCalls).values({
      runId: context.runId,
      client: 'beta',
      route: 'extract',
      model: 'm',
      inputTokens: 7_000,
      outputTokens: 7_000,
      costUsd: 7,
    });

    const totals = await sumRunTotals(db, 'test', context.runId);
    expect(totals).toMatchObject({ inputTokens: 150, outputTokens: 2 });
    expect(totals.costUsd).toBeCloseTo(0.02, 6);
    await closeRun(db, 'test', context.runId, 'done', undefined, totals);
    const [row] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(row).toMatchObject({ status: 'done', inputTokens: 150, outputTokens: 2 });
  });

  it('sums nothing for a run that called no model, rather than answering null', async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    expect(await sumRunTotals(db, 'test', context.runId)).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    await closeRun(db, 'test', context.runId, 'done');
    const [row] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(row).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("closes only its own tenant's run", async () => {
    const alpha = await openRun(db, { client: 'alpha', principal: TEST_PRINCIPAL });
    await closeRun(db, 'beta', alpha.runId, 'done');
    const [stillRunning] = await db.select().from(runs).where(eq(runs.id, alpha.runId));
    expect(stillRunning.status).toBe('running');
    expect(stillRunning.endedAt).toBeNull();
    await closeRun(db, 'alpha', alpha.runId, 'done');
    const [closed] = await db.select().from(runs).where(eq(runs.id, alpha.runId));
    expect(closed.status).toBe('done');
    expect(closed.endedAt).not.toBeNull();
  });
});

describe('finishRun', () => {
  it("still closes the run with the call's status when closing the transport itself rejects", async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    const rejectingClose = () => Promise.reject(new Error('transport already gone'));
    await expect(
      finishRun(db, 'test', context.runId, 'done', () => new Date('2026-09-15T12:00:00Z'), rejectingClose),
    ).resolves.toBeUndefined();
    const [run] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(run).toMatchObject({ status: 'done' });
    expect(run.endedAt).not.toBeNull();
  });
});
