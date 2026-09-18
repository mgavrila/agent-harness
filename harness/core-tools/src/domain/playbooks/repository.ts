import { and, asc, eq } from 'drizzle-orm';
import { playbookRuns, playbooks, type Db } from '@harness/db';
import type { PlaybookRow, PlaybookRunRow, PlaybookSummary } from './types.js';

/** Every playbook of the client, by name. */
export async function listPlaybooks(db: Db, client: string): Promise<PlaybookRow[]> {
  return db.select().from(playbooks).where(eq(playbooks.client, client)).orderBy(asc(playbooks.name));
}

export async function findPlaybook(db: Db, client: string, name: string): Promise<PlaybookRow | null> {
  const [row] = await db
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.client, client), eq(playbooks.name, name)))
    .limit(1);
  return row ?? null;
}

/**
 * Ask for a run off the schedule. A `requested` row is what the host's scheduler claims first
 * on its next tick; nothing runs here, because a tool has a database handle and no route to the
 * loop that opens runs.
 */
export async function requestPlaybookRun(
  db: Db,
  input: { playbookId: string; now: Date; requestedBy: string },
): Promise<PlaybookRunRow> {
  const [row] = await db
    .insert(playbookRuns)
    .values({
      playbookId: input.playbookId,
      scheduledAt: input.now,
      status: 'requested',
      requestedBy: input.requestedBy,
    })
    .returning();
  return row;
}

export function summarisePlaybook(row: PlaybookRow): PlaybookSummary {
  return {
    name: row.name,
    schedule: row.schedule,
    timezone: row.timezone,
    skill: row.skill,
    principal_id: row.principalId,
    surface: row.surface,
    conversation: row.conversation,
    deliver: row.deliver,
    cost_cap_usd: row.costCapUsd,
    timeout_s: row.timeoutS,
    enabled: row.enabled,
    next_run_at: row.nextRunAt?.toISOString() ?? null,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    last_status: row.lastStatus,
  };
}
