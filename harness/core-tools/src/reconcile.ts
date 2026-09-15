import { and, inArray, lte, eq } from 'drizzle-orm';
import { approvals, toolEffects, type Db } from '@harness/db';

export async function expireApprovals(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(approvals)
    .set({ status: 'expired', decidedAt: now })
    .where(and(inArray(approvals.status, ['pending', 'approved']), lte(approvals.expiresAt, now)))
    .returning({ id: approvals.id });
  return rows.length;
}

export async function parkStuckDispatches(db: Db, now: Date, staleAfterMs = 10 * 60_000): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const rows = await db
    .update(toolEffects)
    .set({ status: 'needs_review', lastError: 'dispatch did not complete', updatedAt: now })
    .where(and(eq(toolEffects.status, 'dispatching'), lte(toolEffects.updatedAt, cutoff)))
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
 */
export async function reconcile(db: Db, opts: { now: () => Date; staleAfterMs?: number }): Promise<ReconcileResult> {
  const now = opts.now();
  const approvals_expired = await expireApprovals(db, now);
  const dispatches_parked = await parkStuckDispatches(db, now, opts.staleAfterMs);
  return { approvals_expired, dispatches_parked };
}
