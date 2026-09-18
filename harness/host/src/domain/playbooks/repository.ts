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
 * The file into the table (spec 5.6): every definition upserted by `(client, name)` with every
 * column from the file, `next_run_at` recomputed from `now` — so a firing missed while the host
 * was down is not replayed — and every row of this client that the file no longer names
 * disabled, never deleted, so its run history stays attached. One transaction, so a bad
 * definition halfway through leaves the table as it was.
 */
export async function syncPlaybooks(
  db: Db,
  opts: { client: string; now: Date },
  definitions: readonly PlaybookDefinition[],
): Promise<SyncResult> {
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
        nextRunAt: def.enabled ? nextRunAfter(def.schedule, def.timezone, opts.now) : null,
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
    return { upserted: definitions.length, disabled: disabled.length };
  });
}

/**
 * Take ownership of what is due, in one transaction, with `FOR UPDATE SKIP LOCKED` so two hosts
 * on one database never both fire the same row. Requested runs first (a person asked), then the
 * playbooks whose `next_run_at` has passed: each gets a `playbook_runs` row at its planned time
 * and has `next_run_at` advanced before the transaction commits, so the next tick — or the other
 * host's — finds nothing to claim twice. The claimed rows are returned oldest first; running
 * them is the caller's, outside any transaction.
 */
export async function claimDuePlaybooks(
  db: Db,
  opts: { client: string; now: Date; limit?: number },
): Promise<ClaimedRun[]> {
  const limit = opts.limit ?? 10;
  return withTransaction(db, async (tx) => {
    const claimed: ClaimedRun[] = [];
    const requested = await tx
      .select({ run: playbookRuns, playbook: playbooks })
      .from(playbookRuns)
      .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
      .where(and(eq(playbooks.client, opts.client), eq(playbookRuns.status, 'requested')))
      .orderBy(asc(playbookRuns.scheduledAt))
      .limit(limit)
      .for('update', { of: playbookRuns, skipLocked: true });
    for (const { run, playbook } of requested) {
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
      .limit(limit)
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
          nextRunAt: nextRunAfter(playbook.schedule, playbook.timezone, opts.now),
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
