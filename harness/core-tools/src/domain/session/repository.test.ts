import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runs } from '@harness/db';
import { TEST_PRINCIPAL, useTestDb } from '../../testing.js';
import { closeRun, openRun } from './repository.js';

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
    await closeRun(db, context.runId, 'cancelled', () => new Date('2026-09-15T12:30:00Z'));
    const [row] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(row.status).toBe('cancelled');
    expect(row.endedAt?.toISOString()).toBe('2026-09-15T12:30:00.000Z');
    expect(row.principalId).toBe('u-test');
  });
});
