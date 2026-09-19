import { and, asc, eq, inArray, lte, not } from 'drizzle-orm';
import { playbookRuns, playbooks, withTransaction, type Db } from '@harness/db';
import type { PlaybookRow, PlaybookRunRow, PlaybookRunStatus } from '@harness/core-tools';
import { nextRunAfter, type PlaybookDefinition } from './schema.js';

export interface SyncResult {
  upserted: number;
  disabled: number;
}

/** A claimed firing: the playbook as it stands after the claim, and the `playbook_runs` row now `running`. */
export interface ClaimedRun {
  playbook: PlaybookRow;
  run: PlaybookRunRow;
}

/**
 * Why a firing was closed before anything ran. A `preflight_failed` run made no model call
 * (spec 3.3 step 2), which is exactly what happened here: the playbook stopped being one this
 * host may run between the request and the tick.
 */
const PLAYBOOK_REMOVED = 'playbook removed';
const PLAYBOOK_DISABLED = 'playbook disabled';

/**
 * The file into the table (spec 5.6): every definition upserted by `(client, name)` with every
 * column from the file, `next_run_at` recomputed from `now` — so a firing missed while the host
 * was down is not replayed — and every row of this client that the file no longer names
 * disabled, never deleted, so its run history stays attached. One transaction, so a bad
 * definition halfway through leaves the table as it was.
 */
export async function syncPlaybooks(
  db: Db,
  opts: { client: string; now: Date; file?: string },
  definitions: readonly PlaybookDefinition[],
): Promise<SyncResult> {
  const where = (name: string): string =>
    opts.file === undefined ? `playbook "${name}"` : `playbook "${name}" in ${opts.file}`;
  return withTransaction(db, async (tx) => {
    for (const def of definitions) {
      const values = {
        client: opts.client,
        name: def.name,
        schedule: def.schedule,
        timezone: def.timezone,
        skill: def.skill,
        prompt: def.prompt,
        principalId: def.principal,
        surface: def.surface ?? null,
        conversation: def.conversation ?? null,
        deliver: def.deliver,
        costCapUsd: def.cost_cap_usd,
        timeoutS: def.timeout_s,
        enabled: def.enabled,
        nextRunAt: def.enabled ? nextRunAfter(def.schedule, def.timezone, opts.now, where(def.name)) : null,
        updatedAt: opts.now,
      };
      await tx
        .insert(playbooks)
        .values(values)
        .onConflictDoUpdate({ target: [playbooks.client, playbooks.name], set: values });
    }
    const names = definitions.map((d) => d.name);
    const disabled = await tx
      .update(playbooks)
      .set({ enabled: false, nextRunAt: null, updatedAt: opts.now })
      .where(
        and(
          eq(playbooks.client, opts.client),
          eq(playbooks.enabled, true),
          names.length === 0 ? undefined : not(inArray(playbooks.name, names)),
        ),
      )
      .returning({ id: playbooks.id });
    await failStrandedRuns(
      tx,
      opts,
      disabled.map((row) => row.id),
    );
    return { upserted: definitions.length, disabled: disabled.length };
  });
}

/**
 * Close the runs asked for by hand whose playbook this client's file no longer enables. The claim
 * takes enabled playbooks only, so a firing left `requested` here would wait for a tick that never
 * comes; it is closed as `preflight_failed` — nothing ran, no model was called — and never
 * deleted, so the person who asked can see what became of it. `removed` names the playbooks this
 * sync has just taken out of the file, which is the difference between "your playbook is gone" and
 * "your playbook is switched off", and all the run row can say about either.
 *
 * The rows are locked with `SKIP LOCKED` and only the locked ones updated, so this never waits on a
 * run row. A tick claiming right now holds its run row and is waiting for the playbook row this
 * transaction already holds; waiting back would close that into a deadlock. The run the lock skips
 * is exactly the one that claim is re-reading the playbook for, and the claim closes it there.
 */
async function failStrandedRuns(
  tx: Db,
  opts: { client: string; now: Date },
  removed: readonly string[],
): Promise<void> {
  const off = await tx
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.client, opts.client), eq(playbooks.enabled, false)));
  if (off.length === 0) return;
  const stranded = await tx
    .select({ id: playbookRuns.id, playbookId: playbookRuns.playbookId })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.status, 'requested'),
        inArray(
          playbookRuns.playbookId,
          off.map((row) => row.id),
        ),
      ),
    )
    .for('update', { skipLocked: true });
  const gone = new Set(removed);
  const byReason: [reason: string, ids: string[]][] = [
    [PLAYBOOK_REMOVED, stranded.filter((row) => gone.has(row.playbookId)).map((row) => row.id)],
    [PLAYBOOK_DISABLED, stranded.filter((row) => !gone.has(row.playbookId)).map((row) => row.id)],
  ];
  for (const [reason, ids] of byReason) {
    if (ids.length === 0) continue;
    await tx
      .update(playbookRuns)
      .set({ status: 'preflight_failed', error: reason, endedAt: opts.now })
      .where(inArray(playbookRuns.id, ids));
  }
}

/**
 * How many playbooks one tick claims.
 *
 * A bound, not a setting: a tick that claimed every due row would run them all before the next
 * one, and with two hosts on one database the bound is also what keeps one of them from taking the
 * whole queue. Ten is more than any client schedules in one minute, and what a tick leaves behind
 * is still due thirty seconds later. A constant rather than an argument nothing would ever pass,
 * so there is one number to find rather than two places to look.
 */
export const CLAIM_BATCH = 10;

/**
 * Take ownership of what is due, in one transaction, with `FOR UPDATE SKIP LOCKED` so two hosts
 * on one database never both fire the same row. Requested runs first (a person asked), then the
 * playbooks whose `next_run_at` has passed: each gets a `playbook_runs` row at its planned time
 * and has `next_run_at` advanced before the transaction commits, so the next tick — or the other
 * host's — finds nothing to claim twice. The claimed rows are returned oldest first; running
 * them is the caller's, outside any transaction.
 */
export async function claimDuePlaybooks(db: Db, opts: { client: string; now: Date }): Promise<ClaimedRun[]> {
  return withTransaction(db, async (tx) => {
    const claimed: ClaimedRun[] = [];
    const requested = await tx
      .select({ run: playbookRuns })
      .from(playbookRuns)
      .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
      .where(and(eq(playbooks.client, opts.client), eq(playbooks.enabled, true), eq(playbookRuns.status, 'requested')))
      .orderBy(asc(playbookRuns.scheduledAt))
      .limit(CLAIM_BATCH)
      .for('update', { of: playbookRuns, skipLocked: true });
    for (const { run } of requested) {
      // Read the playbook again under its own lock. The join above locks the run row only, so the
      // playbook it matched is a snapshot taken without one: a sync committing between that select
      // and this loop would otherwise hand the caller a stale prompt, skill or service principal,
      // and the run would act as an identity the file no longer gives it.
      const [playbook] = await tx
        .select()
        .from(playbooks)
        .where(eq(playbooks.id, run.playbookId))
        .limit(1)
        .for('update');
      if (!playbook || !playbook.enabled) {
        // Disabled by a sync that committed while this tick was claiming. Closing it here is what
        // `failStrandedRuns` could not do: it stepped over this row because the lock was held.
        await tx
          .update(playbookRuns)
          .set({ status: 'preflight_failed', error: PLAYBOOK_DISABLED, endedAt: opts.now })
          .where(eq(playbookRuns.id, run.id));
        continue;
      }
      const [started] = await tx
        .update(playbookRuns)
        .set({ status: 'running', startedAt: opts.now })
        .where(eq(playbookRuns.id, run.id))
        .returning();
      claimed.push({ playbook, run: started });
    }
    const due = await tx
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.client, opts.client), eq(playbooks.enabled, true), lte(playbooks.nextRunAt, opts.now)))
      .orderBy(asc(playbooks.nextRunAt))
      .limit(CLAIM_BATCH)
      .for('update', { skipLocked: true });
    for (const playbook of due) {
      const [run] = await tx
        .insert(playbookRuns)
        .values({
          playbookId: playbook.id,
          scheduledAt: playbook.nextRunAt ?? opts.now,
          status: 'running',
          startedAt: opts.now,
        })
        .returning();
      const [advanced] = await tx
        .update(playbooks)
        .set({
          nextRunAt: nextRunAfter(playbook.schedule, playbook.timezone, opts.now, `playbook "${playbook.name}"`),
          lastRunAt: opts.now,
          updatedAt: opts.now,
        })
        .where(eq(playbooks.id, playbook.id))
        .returning();
      claimed.push({ playbook: advanced, run });
    }
    return claimed;
  });
}

/** Close a claimed firing with its outcome and stamp the playbook's `last_status`. The error is truncated like `tool_effects.last_error`. */
export async function finishPlaybookRun(
  db: Db,
  id: string,
  outcome: {
    status: Exclude<PlaybookRunStatus, 'requested' | 'running'>;
    runId: string | null;
    attempts: number;
    error: string | null;
    endedAt: Date;
  },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const [row] = await tx
      .update(playbookRuns)
      .set({
        status: outcome.status,
        runId: outcome.runId,
        attempts: outcome.attempts,
        error: outcome.error?.slice(0, 500) ?? null,
        endedAt: outcome.endedAt,
      })
      .where(eq(playbookRuns.id, id))
      .returning({ playbookId: playbookRuns.playbookId });
    // No such firing: an operator closed it by hand between the claim and here, which the
    // runbook tells them to do for a row stranded `running`. Nothing to stamp, and a throw
    // inside this transaction would only turn their cleanup into a scheduler error.
    if (!row) return;
    await tx
      .update(playbooks)
      .set({ lastStatus: outcome.status, updatedAt: outcome.endedAt })
      .where(eq(playbooks.id, row.playbookId));
  });
}
