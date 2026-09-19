import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, playbookRuns, playbooks, withTransaction } from '@harness/db';
import { TEST_DATABASE_URL } from '@harness/db/testing';
import { requestPlaybookRun } from '@harness/core-tools';
import type { PlaybookDefinition } from '@harness/config-api';
import { useTestDb } from '../../testing.js';
import { CLAIM_BATCH, claimDuePlaybooks, finishPlaybookRun, syncPlaybooks, type ClaimedRun } from './repository.js';

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
    await requestPlaybookRun(db, { client: 'test', playbookId: first.id, now: later, requestedBy: 'u-x' });
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
      client: 'test',
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

  it('never runs a playbook the file has disabled: the sync fails its pending request in preflight', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [row] = await db.select().from(playbooks);
    await requestPlaybookRun(db, { client: 'test', playbookId: row.id, now: NOW, requestedBy: 'u-practice-manager' });

    // The operator takes the playbook out of the file and the host restarts.
    expect(await syncPlaybooks(db, { client: 'test', now: NOW }, [])).toEqual({ upserted: 0, disabled: 1 });
    const [closed] = await db.select().from(playbookRuns);
    // Taken out of the file, so the run row says so; nothing ran, so it never left preflight.
    expect(closed).toMatchObject({ status: 'preflight_failed', error: 'playbook removed', runId: null, attempts: 0 });
    expect(closed.endedAt?.toISOString()).toBe(NOW.toISOString());

    // The tick that follows has nothing to claim: not the request, and not the schedule either.
    expect(await claimDuePlaybooks(db, { client: 'test', now: new Date('2026-09-16T07:00:30Z') })).toEqual([]);
    expect((await db.select().from(playbookRuns))[0].status).toBe('preflight_failed');

    // A request that arrives for a disabled playbook after that sync is not claimed either. The
    // claim selects enabled playbooks only, so it passes the row over untouched rather than
    // closing it; the next sync is what closes it.
    await requestPlaybookRun(db, { client: 'test', playbookId: row.id, now: NOW, requestedBy: 'u-practice-manager' });
    expect(await claimDuePlaybooks(db, { client: 'test', now: new Date('2026-09-16T07:00:30Z') })).toEqual([]);
    const late = await db.select().from(playbookRuns).orderBy(playbookRuns.createdAt);
    expect(late.map((r) => r.status)).toEqual(['preflight_failed', 'requested']);
    // The next sync closes it too. This one takes nothing out of the file, so the reason is that
    // the playbook is switched off rather than gone.
    await syncPlaybooks(db, { client: 'test', now: NOW }, []);
    const settled = await db
      .select({ status: playbookRuns.status, error: playbookRuns.error })
      .from(playbookRuns)
      .orderBy(playbookRuns.createdAt);
    expect(settled).toEqual([
      { status: 'preflight_failed', error: 'playbook removed' },
      { status: 'preflight_failed', error: 'playbook disabled' },
    ]);
  });

  it('returns the playbook as it stands at the claim, not as it was when the run was requested', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [row] = await db.select().from(playbooks);
    await requestPlaybookRun(db, { client: 'test', playbookId: row.id, now: NOW, requestedBy: 'u-practice-manager' });
    // A re-sync between the request and the tick: a different prompt, and a different principal.
    await syncPlaybooks(db, { client: 'test', now: NOW }, [
      { ...nightly, prompt: 'Run the edited one.', principal: 'svc-renewals' },
    ]);
    const [claimed] = await claimDuePlaybooks(db, { client: 'test', now: NOW });
    expect(claimed.playbook).toMatchObject({ id: row.id, prompt: 'Run the edited one.', principalId: 'svc-renewals' });
    expect(claimed.run.requestedBy).toBe('u-practice-manager');
  });

  it('claims at most CLAIM_BATCH playbooks in one tick, leaving the rest for the next', async () => {
    const at = new Date('2026-09-16T07:00:00Z');
    await syncPlaybooks(
      db,
      { client: 'test', now: NOW },
      Array.from({ length: CLAIM_BATCH + 2 }, (_, i) => ({ ...nightly, name: `nightly-${i}` })),
    );
    await db.update(playbooks).set({ nextRunAt: at });
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toHaveLength(CLAIM_BATCH);
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toHaveLength(2);
  });
});

describe('claimDuePlaybooks with two hosts on one database', () => {
  /**
   * The claim's reason for existing: two hosts ticking at once never both fire the same firing.
   * One host holds its claim transaction open on its own connection while the other ticks on a
   * second connection, so the rows really are locked and `SKIP LOCKED` really is what steps over
   * them. Nothing sleeps: the second tick is raced against a 200 ms timer only so that a claim
   * that blocks instead of skipping fails the assertion by name rather than timing the suite out.
   */
  async function tickWhileHeld(
    held: (claimedByFirst: Promise<ClaimedRun[]>) => Promise<ClaimedRun[] | 'blocked'>,
    at: Date,
  ): Promise<{ first: ClaimedRun[]; second: ClaimedRun[] | 'blocked' }> {
    let signal!: (runs: ClaimedRun[]) => void;
    const claimedByFirst = new Promise<ClaimedRun[]>((resolve) => {
      signal = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withTransaction(db, async (tx) => {
      signal(await claimDuePlaybooks(tx, { client: 'test', now: at }));
      await gate;
    });
    try {
      const second = await held(claimedByFirst);
      return { first: await claimedByFirst, second };
    } finally {
      release();
      await first;
    }
  }

  function second(at: Date): Promise<ClaimedRun[] | 'blocked'> {
    const other = createDb(TEST_DATABASE_URL);
    return Promise.race([
      claimDuePlaybooks(other.db, { client: 'test', now: at }),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ]).finally(() => void other.close());
  }

  it('the second host claims nothing while the first holds a due playbook it has claimed', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const at = new Date('2026-09-16T07:00:30Z');
    const { first, second: other } = await tickWhileHeld(async (claimedByFirst) => {
      await claimedByFirst;
      return second(at);
    }, at);
    expect(first).toHaveLength(1);
    expect(other).toEqual([]);
    // And once the first host has committed, the advanced next_run_at keeps it that way.
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toEqual([]);
    expect(await db.select().from(playbookRuns)).toHaveLength(1);
  });

  it('a sync cannot edit a playbook out from under a claim that is taking it', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [row] = await db.select().from(playbooks);
    await requestPlaybookRun(db, { client: 'test', playbookId: row.id, now: NOW, requestedBy: 'u-practice-manager' });
    const other = createDb(TEST_DATABASE_URL);
    let signal!: (runs: ClaimedRun[]) => void;
    const claimedByFirst = new Promise<ClaimedRun[]>((resolve) => {
      signal = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withTransaction(db, async (tx) => {
      signal(await claimDuePlaybooks(tx, { client: 'test', now: NOW }));
      await gate;
    });
    let sync: Promise<unknown> | undefined;
    try {
      const claimed = await claimedByFirst;
      expect(claimed).toHaveLength(1);
      // The claim holds the playbook row itself, not only its run row, so the restart of another
      // host cannot swap the prompt, the skill or the service principal under a firing already
      // being taken. Without that lock this sync commits while the claim is still open.
      sync = syncPlaybooks(other.db, { client: 'test', now: NOW }, [
        { ...nightly, prompt: 'Run the edited one.', principal: 'svc-renewals' },
      ]);
      const raced = await Promise.race([
        sync.then(() => 'committed'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ]);
      expect(raced).toBe('blocked');
      expect(claimed[0].playbook).toMatchObject({ prompt: 'Run it.', principalId: 'svc-playbooks' });
    } finally {
      release();
      await first;
      await sync;
      await other.close();
    }
    // Once the claim has committed the sync goes through, and the edit lands.
    expect((await db.select().from(playbooks))[0].prompt).toBe('Run the edited one.');
  });

  it('the second host does not take a requested run the first host has locked', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [row] = await db.select().from(playbooks);
    await requestPlaybookRun(db, { client: 'test', playbookId: row.id, now: NOW, requestedBy: 'u-practice-manager' });
    // At NOW nothing is due, so the requested branch is the only one with anything to take.
    const { first, second: other } = await tickWhileHeld(async (claimedByFirst) => {
      await claimedByFirst;
      return second(NOW);
    }, NOW);
    expect(first.map((c) => c.run.requestedBy)).toEqual(['u-practice-manager']);
    expect(other).toEqual([]);
    expect(await db.select().from(playbookRuns)).toHaveLength(1);
  });
});

describe('the tenant column on playbook runs', () => {
  it("claims only its own tenant's due playbooks and writes the tenant on the firing", async () => {
    const at = new Date('2026-09-16T07:00:30Z');
    for (const client of ['alpha', 'beta']) {
      await syncPlaybooks(db, { client, now: NOW, file: 'document' }, [nightly]);
    }
    const claimed = await claimDuePlaybooks(db, { client: 'alpha', now: at });
    expect(claimed).toHaveLength(1);
    const [row] = await db.select().from(playbookRuns);
    expect(row.client).toBe('alpha');
    expect(await claimDuePlaybooks(db, { client: 'gamma', now: at })).toEqual([]);
  });

  it("claims and closes none of a firing another tenant's writer left behind", async () => {
    const at = new Date('2026-09-16T07:00:30Z');
    await syncPlaybooks(db, { client: 'alpha', now: NOW }, [nightly]);
    const [playbook] = await db.select().from(playbooks);
    // A writer that was not correct: a requested firing under alpha's playbook carrying another
    // tenant's id. The join reaches alpha's playbook, so a claim that only joined would take it.
    await db
      .insert(playbookRuns)
      .values({ client: 'beta', playbookId: playbook.id, scheduledAt: NOW, status: 'requested' });

    const claimed = await claimDuePlaybooks(db, { client: 'alpha', now: at });
    expect(claimed.map((c) => c.run.client)).toEqual(['alpha']);
    const [theirs] = await db.select().from(playbookRuns).where(eq(playbookRuns.client, 'beta'));
    expect(theirs.status).toBe('requested');

    // And closing it as alpha does nothing: the id is not alpha's to close.
    await finishPlaybookRun(db, 'alpha', theirs.id, {
      status: 'done',
      runId: null,
      attempts: 1,
      error: null,
      endedAt: at,
    });
    const [after] = await db.select().from(playbookRuns).where(eq(playbookRuns.client, 'beta'));
    expect(after.status).toBe('requested');
  });

  it("strands none of another tenant's firings when a playbook leaves the file", async () => {
    await syncPlaybooks(db, { client: 'alpha', now: NOW }, [nightly]);
    const [playbook] = await db.select().from(playbooks);
    await db
      .insert(playbookRuns)
      .values({ client: 'beta', playbookId: playbook.id, scheduledAt: NOW, status: 'requested' });

    await syncPlaybooks(db, { client: 'alpha', now: NOW }, []);
    const [theirs] = await db.select().from(playbookRuns).where(eq(playbookRuns.client, 'beta'));
    expect(theirs.status).toBe('requested');
  });
});

describe('finishPlaybookRun', () => {
  it('closes the run row and stamps the playbook last_status', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [claimed] = await claimDuePlaybooks(db, { client: 'test', now: new Date('2026-09-16T07:00:30Z') });
    const ended = new Date('2026-09-16T07:02:00Z');
    await finishPlaybookRun(db, 'test', claimed.run.id, {
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

  it('closes nothing and throws nothing when the firing is no longer there', async () => {
    await syncPlaybooks(db, { client: 'test', now: NOW }, [nightly]);
    const [before] = await db.select().from(playbooks);
    // An operator closed a stranded row by hand between the claim and here, as the runbook says.
    await expect(
      finishPlaybookRun(db, 'test', randomUUID(), {
        status: 'done',
        runId: null,
        attempts: 1,
        error: null,
        endedAt: NOW,
      }),
    ).resolves.toBeUndefined();
    expect(await db.select().from(playbookRuns)).toEqual([]);
    const [after] = await db.select().from(playbooks);
    expect(after.lastStatus).toBe(before.lastStatus);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});
