import { and, inArray, lte, eq } from 'drizzle-orm';
import { approvals, toolEffects, type Db } from '@harness/db';

export async function expireApprovals(db: Db, now: Date, client?: string): Promise<number> {
  const rows = await db
    .update(approvals)
    .set({ status: 'expired', decidedAt: now })
    .where(
      and(
        inArray(approvals.status, ['pending', 'approved']),
        lte(approvals.expiresAt, now),
        ...(client ? [eq(approvals.client, client)] : []),
      ),
    )
    .returning({ id: approvals.id });
  return rows.length;
}

export async function parkStuckDispatches(
  db: Db,
  now: Date,
  staleAfterMs = 10 * 60_000,
  client?: string,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const rows = await db
    .update(toolEffects)
    .set({ status: 'needs_review', lastError: 'dispatch did not complete', updatedAt: now })
    .where(
      and(
        eq(toolEffects.status, 'dispatching'),
        lte(toolEffects.updatedAt, cutoff),
        ...(client ? [eq(toolEffects.client, client)] : []),
      ),
    )
    .returning({ id: toolEffects.id });
  return rows.length;
}

export interface ReconcileResult {
  approvals_expired: number;
  dispatches_parked: number;
}

/**
 * Repair state left behind by a crash or by time passing: retire approvals
 * past their TTL and park dispatches that never reported completion for
 * human review. Idempotent; safe to run at startup and on a schedule.
 *
 * Pass `client` to limit the repair to one tenant's rows — the MCP tool does,
 * so an agent acting for one client can never retire another client's
 * approvals. Process startup runs it unscoped, as an operator task.
 */
export async function reconcile(
  db: Db,
  opts: { now: () => Date; staleAfterMs?: number; client?: string },
): Promise<ReconcileResult> {
  const now = opts.now();
  const approvals_expired = await expireApprovals(db, now, opts.client);
  const dispatches_parked = await parkStuckDispatches(db, now, opts.staleAfterMs, opts.client);
  return { approvals_expired, dispatches_parked };
}
