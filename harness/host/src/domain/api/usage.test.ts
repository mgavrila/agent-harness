import { describe, expect, it } from 'vitest';
import { modelCalls, runs } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { readUsage } from './usage.js';

const db = useTestDb();

async function seed(
  client: string,
  principalId: string,
  day: string,
  totals: { i: number; o: number; c: number },
): Promise<string> {
  const [run] = await db
    .insert(runs)
    .values({
      client,
      principalId,
      status: 'done',
      startedAt: new Date(`${day}T09:00:00Z`),
      endedAt: new Date(`${day}T09:00:30Z`),
      inputTokens: totals.i,
      outputTokens: totals.o,
      costUsd: totals.c,
    })
    .returning();
  await db.insert(modelCalls).values({
    runId: run.id,
    client,
    route: 'chat',
    model: 'm',
    inputTokens: totals.i,
    outputTokens: totals.o,
    costUsd: totals.c,
  });
  return run.id;
}

describe('readUsage', () => {
  it("sums a tenant's runs by principal and day", async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 100, o: 20, c: 0.01 });
    await seed('alpha', 'u-one', '2026-09-10', { i: 50, o: 10, c: 0.005 });
    await seed('alpha', 'u-two', '2026-09-11', { i: 7, o: 1, c: 0.001 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.principal_id === 'u-one')!;
    expect(first).toMatchObject({ runs: 2, input_tokens: 150, output_tokens: 30, runs_done: 2 });
    expect(first.cost_usd).toBeCloseTo(0.015, 6);
    expect(first.duration_seconds).toBe(60);
    expect(first.sandbox_seconds).toBe(0);
  });

  it("returns none of another tenant's rows, however wide the window", async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 100, o: 20, c: 0.01 });
    await seed('beta', 'u-one', '2026-09-10', { i: 999, o: 999, c: 9.99 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2030-01-01T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(100);
  });

  it('bounds the window at both ends', async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 1, o: 1, c: 0 });
    await seed('alpha', 'u-one', '2026-09-20', { i: 2, o: 2, c: 0 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-15T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(2);
  });

  it('carries no message, no tool argument and no conversation (invariant 16)', async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 1, o: 1, c: 0 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    // The column list, asserted whole. A field added to the view without a thought is a field
    // this fails on, which is the point: an export is the one place content leaves by accident.
    expect(Object.keys(rows[0]).sort()).toEqual([
      'approvals_decided',
      'approvals_requested',
      'client',
      'cost_usd',
      'day',
      'duration_seconds',
      'input_tokens',
      'output_tokens',
      'principal_id',
      'runs',
      'runs_cancelled',
      'runs_done',
      'runs_error',
      'runs_running',
      'sandbox_seconds',
    ]);
  });

  it('answers an empty list for a tenant that has done nothing, rather than failing', async () => {
    expect(
      await readUsage(db, {
        client: 'nobody',
        from: new Date('2026-09-01T00:00:00Z'),
        to: new Date('2026-09-30T00:00:00Z'),
      }),
    ).toEqual([]);
  });
});
