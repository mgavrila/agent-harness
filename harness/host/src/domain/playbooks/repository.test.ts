import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { playbookRuns, playbooks } from '@harness/db';
import { requestPlaybookRun } from '@harness/core-tools';
import { useTestDb } from '../../testing.js';
import { claimDuePlaybooks, finishPlaybookRun, syncPlaybooks } from './repository.js';
import type { PlaybookDefinition } from './schema.js';

const db = useTestDb();
const NOW = new Date('2026-09-15T12:00:00Z');

const nightly: PlaybookDefinition = {
  name: 'nightly',
  schedule: '0 7 * * *',
  timezone: 'UTC',
  skill: 'a-skill',
  prompt: 'Run it.',
  principal: 'svc-playbooks',
  surface: undefined,
  conversation: undefined,
  deliver: 'none',
  cost_cap_usd: 0.5,
  timeout_s: 300,
  enabled: true,
};

describe('syncPlaybooks', () => {
  it('upserts by name, recomputes next_run_at from the clock, and disables a playbook that left the file', async () => {
    expect(await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly])).toEqual({ upserted: 1, disabled: 0 });
    const [first] = await db.select().from(playbooks);
    expect(first).toMatchObject({
      client: 'test',
      name: 'nightly',
      principalId: 'svc-playbooks',
      enabled: true,
      timeoutS: 300,
    });
    expect(first.nextRunAt?.toISOString()).toBe('2026-09-16T07:00:00.000Z');

    // Edited and re-synced later: same row, new values, next firing from the new clock.
    const later = new Date('2026-09-20T08:00:00Z');
    await syncPlaybooks(db, { client: 'test', now: later }, [
      { ...nightly, schedule: '30 6 * * *', prompt: 'Run it again.' },
    ]);
    const [second] = await db.select().from(playbooks);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ schedule: '30 6 * * *', prompt: 'Run it again.' });
    expect(second.nextRunAt?.toISOString()).toBe('2026-09-21T06:30:00.000Z');

    // Gone from the file: disabled, not deleted; its history stays attached.
    await requestPlaybookRun(db, { playbookId: first.id, now: later, requestedBy: 'u-x' });
    expect(await syncPlaybooks(db, { client: 'test', now: later }, [])).toEqual({ upserted: 0, disabled: 1 });
    const [third] = await db.select().from(playbooks);
    expect(third).toMatchObject({ id: first.id, enabled: false, nextRunAt: null });
    expect(await db.select().from(playbookRuns)).toHaveLength(1);

    // Back in the file: enabled again.
    await syncPlaybooks(db, { client: 'test', now: later }, [nightly]);
    expect((await db.select().from(playbooks))[0].enabled).toBe(true);
  });

  it('leaves a disabled entry disabled with no next firing, and never touches another client', async () => {
    await syncPlaybooks(db, { client: 'other', now: NOW }, [nightly]);
    await syncPlaybooks(db, { client: 'test', now: NOW }, [{ ...nightly, enabled: false }]);
    const rows = await db.select().from(playbooks).orderBy(playbooks.client);
    expect(rows.map((r) => [r.client, r.enabled, r.nextRunAt?.toISOString() ?? null])).toEqual([
      ['other', true, '2026-09-16T07:00:00.000Z'],
      ['test', false, null],
    ]);
  });
});

describe('claimDuePlaybooks', () => {
  it('claims a due playbook once, opens its run row at the planned time, and advances next_run_at', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    // Nothing is due yet.
    expect(await claimDuePlaybooks(db, { client: 'test', now: NOW })).toEqual([]);
    const at = new Date('2026-09-16T07:00:30Z');
    const claimed = await claimDuePlaybooks(db, { client: 'test', now: at });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].run).toMatchObject({ status: 'running', attempts: 0, requestedBy: null });
    expect(claimed[0].run.scheduledAt.toISOString()).toBe('2026-09-16T07:00:00.000Z');
    expect(claimed[0].run.startedAt?.toISOString()).toBe(at.toISOString());
    expect(claimed[0].playbook.nextRunAt?.toISOString()).toBe('2026-09-17T07:00:00.000Z');
    expect(claimed[0].playbook.lastRunAt?.toISOString()).toBe(at.toISOString());
    // A second tick at the same instant finds nothing: the row was advanced inside the claim.
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toEqual([]);
  });

  it('claims requested runs first, then the due ones, and skips disabled and foreign playbooks', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly, { ...nightly, name: 'off', enabled: false }]);
    await syncPlaybooks(db, { client: 'other', now: NOW }, [nightly]);
    const [mine] = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.client, 'test'), eq(playbooks.name, 'nightly')))
      .limit(1);
    const requested = await requestPlaybookRun(db, {
      playbookId: mine.id,
      now: NOW,
      requestedBy: 'u-practice-manager',
    });
    const at = new Date('2026-09-16T07:00:30Z');
    const claimed = await claimDuePlaybooks(db, { client: 'test', now: at });
    expect(claimed.map((c) => [c.playbook.name, c.run.status, c.run.requestedBy])).toEqual([
      ['nightly', 'running', 'u-practice-manager'],
      ['nightly', 'running', null],
    ]);
    expect(claimed[0].run.id).toBe(requested.id);
    expect(claimed[0].run.startedAt?.toISOString()).toBe(at.toISOString());
    // The other client's playbook is still due for its own host.
    const [other] = await db.select().from(playbooks).where(eq(playbooks.client, 'other'));
    expect(other.nextRunAt?.toISOString()).toBe('2026-09-16T07:00:00.000Z');
  });
});

describe('finishPlaybookRun', () => {
  it('closes the run row and stamps the playbook last_status', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [claimed] = await claimDuePlaybooks(db, { client: 'test', now: new Date('2026-09-16T07:00:30Z') });
    const ended = new Date('2026-09-16T07:02:00Z');
    await finishPlaybookRun(db, claimed.run.id, {
      status: 'failed',
      runId: null,
      attempts: 2,
      error: 'x'.repeat(600),
      endedAt: ended,
    });
    const [run] = await db.select().from(playbookRuns);
    expect(run).toMatchObject({ status: 'failed', attempts: 2, runId: null });
    expect(run.error).toHaveLength(500);
    expect(run.endedAt?.toISOString()).toBe(ended.toISOString());
    expect((await db.select().from(playbooks))[0].lastStatus).toBe('failed');
  });
});
