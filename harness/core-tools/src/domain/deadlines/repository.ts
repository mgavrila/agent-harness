import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { attachments, deadlines, records } from '@harness/db';
import type { DeadlineItem, DeadlinesComputeResult, DeadlinesUpcomingResult } from '@harness/pack-api';
import type { ToolDeps } from '../tooling/types.js';
import { requireRecord } from '../records/repository.js';
import { addDays, bucketFor, computeDeadlines, daysUntil, digestKeyFor } from './compute.js';

/** Identifies a deadline row within a record, matching `deadlines_attachment_kind_uq`. */
const deadlineKey = (d: { attachmentId: string; kind: string }) => `${d.attachmentId}:${d.kind}`;

interface UpcomingArgs {
  within_days: number;
  /** `YYYY-MM-DD`; `deps.now()` when absent. */
  today?: string;
  limit: number;
  /** Only records of this kind. Absent lists every kind this client holds. */
  record_kind?: string;
}

/**
 * `deadlines_compute`: recompute this record's deadlines from its attachments and reconcile the
 * stored rows with the result. The dates come from `computeDeadlines`; this function only reads
 * and writes them, and asks the registry how long each kind's lead time is.
 *
 * `recordKind` pins the write the way `requireRecord`'s does every read: a pack's renamed
 * `deadlines_compute` passes its own kind so that a foreign record is a `ToolError` naming both
 * kinds, rather than a recompute reported back through the wrong pack's vocabulary. Omitting it
 * keeps the generic behaviour — any record of this client.
 */
export async function recomputeDeadlines(
  deps: ToolDeps,
  recordId: string,
  recordKind?: string,
): Promise<DeadlinesComputeResult> {
  await requireRecord(deps, recordId, recordKind);
  const rows = await deps.db.select().from(attachments).where(eq(attachments.recordId, recordId));
  const computed = computeDeadlines(
    rows.map((a) => ({ id: a.id, kind: a.kind, expiresAt: a.expiresAt })),
    (kind) => deps.packs.attachmentKind(kind)?.leadDays ?? 0,
  );
  for (const d of computed) {
    await deps.db
      .insert(deadlines)
      .values({ client: deps.client, recordId, attachmentId: d.attachmentId, kind: d.kind, dueAt: d.dueAt })
      .onConflictDoUpdate({
        target: [deadlines.attachmentId, deadlines.kind],
        // A moved due date invalidates any notification already sent for the old one, so clear
        // the marker; an unchanged date keeps it, so the same reminder is not sent twice.
        set: {
          dueAt: d.dueAt,
          notifiedAt: sql`CASE WHEN ${deadlines.dueAt} = ${d.dueAt} THEN ${deadlines.notifiedAt} ELSE NULL END`,
        },
      });
  }
  // An attachment that lost its expiry, or was removed, leaves deadlines behind that nothing
  // recomputes. Retire whatever this run did not produce.
  const computedKeys = new Set(computed.map(deadlineKey));
  const existingRows = await deps.db
    .select({ id: deadlines.id, attachmentId: deadlines.attachmentId, kind: deadlines.kind })
    .from(deadlines)
    .where(eq(deadlines.recordId, recordId));
  const staleIds = existingRows.filter((r) => !computedKeys.has(deadlineKey(r))).map((r) => r.id);
  if (staleIds.length > 0) {
    await deps.db.delete(deadlines).where(inArray(deadlines.id, staleIds));
  }
  return { deadlines: computed.map((d) => ({ attachment_id: d.attachmentId, kind: d.kind, due_at: d.dueAt })) };
}

/**
 * `deadlines_upcoming`: this client's deadlines due inside the window, overdue ones included,
 * sorted by due date. The urgency bucket and the digest key come from `compute.ts`.
 */
export async function upcomingDeadlines(
  deps: ToolDeps,
  { within_days, today, limit, record_kind }: UpcomingArgs,
): Promise<DeadlinesUpcomingResult> {
  const todayDate = today ? new Date(`${today}T00:00:00Z`) : deps.now();
  const todayStr = todayDate.toISOString().slice(0, 10);
  const horizon = addDays(todayStr, within_days);
  const scope = [eq(records.client, deps.client), lte(deadlines.dueAt, horizon)];
  if (record_kind !== undefined) scope.push(eq(records.kind, record_kind));
  const rows = await deps.db
    .select({
      recordId: deadlines.recordId,
      recordName: records.name,
      attachmentId: deadlines.attachmentId,
      attachmentKind: attachments.kind,
      kind: deadlines.kind,
      dueAt: deadlines.dueAt,
    })
    .from(deadlines)
    .innerJoin(attachments, eq(deadlines.attachmentId, attachments.id))
    .innerJoin(records, eq(deadlines.recordId, records.id))
    .where(and(...scope))
    .orderBy(asc(deadlines.dueAt))
    .limit(limit);
  const items: DeadlineItem[] = rows.map((r) => {
    const daysLeft = daysUntil(r.dueAt, todayDate);
    return {
      record_id: r.recordId,
      record_name: r.recordName,
      attachment_id: r.attachmentId,
      attachment_kind: r.attachmentKind,
      kind: r.kind,
      due_at: r.dueAt,
      days_left: daysLeft,
      overdue: daysLeft < 0,
      bucket: bucketFor(daysLeft),
    };
  });
  const digest_key = digestKeyFor(
    items.map((i) => ({ attachmentId: i.attachment_id, kind: i.kind, bucket: i.bucket })),
  );
  return { items, digest_key };
}
