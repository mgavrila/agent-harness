import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { attachments, deadlines, records } from '@harness/db';
import type { ToolDeps } from '../tooling/types.js';
import { requireProvider } from '../providers/repository.js';
import { computeDeadlines, daysUntil, addDays, bucketFor, digestKeyFor, type UrgencyBucket } from './compute.js';

/** Identifies a deadline row within a provider, matching `deadlines_attachment_kind_uq`. */
const deadlineKey = (d: { credentialId: string; kind: string }) => `${d.credentialId}:${d.kind}`;

interface UpcomingArgs {
  window_days: number;
  /** `YYYY-MM-DD`; `deps.now()` when absent. */
  today?: string;
  limit: number;
}

export interface UpcomingItem {
  provider_id: string;
  provider_name: string;
  credential_id: string;
  credential_kind: string;
  kind: string;
  due_at: string;
  days_left: number;
  overdue: boolean;
  bucket: UrgencyBucket;
}

/**
 * `deadlines_compute`: recompute this provider's deadlines from its credentials
 * and reconcile the stored rows with the result. The dates themselves come from
 * `computeDeadlines`; this function only reads and writes them.
 */
export async function recomputeDeadlines(
  deps: ToolDeps,
  providerId: string,
): Promise<{ deadlines: { credential_id: string; kind: string; due_at: string }[] }> {
  await requireProvider(deps, providerId);
  const creds = await deps.db.select().from(attachments).where(eq(attachments.recordId, providerId));
  const computed = computeDeadlines(creds.map((c) => ({ id: c.id, kind: c.kind, expiresAt: c.expiresAt })));
  for (const d of computed) {
    await deps.db
      .insert(deadlines)
      .values({ recordId: providerId, attachmentId: d.credentialId, kind: d.kind, dueAt: d.dueAt })
      .onConflictDoUpdate({
        target: [deadlines.attachmentId, deadlines.kind],
        // A moved due date invalidates any notification already sent for the
        // old one, so clear the marker; an unchanged date keeps it, so the
        // same reminder is not sent twice.
        set: {
          dueAt: d.dueAt,
          notifiedAt: sql`CASE WHEN ${deadlines.dueAt} = ${d.dueAt} THEN ${deadlines.notifiedAt} ELSE NULL END`,
        },
      });
  }
  // A credential that lost its expiry, or was removed, leaves deadlines
  // behind that nothing recomputes. Retire whatever this run did not produce.
  const computedKeys = new Set(computed.map(deadlineKey));
  const existingRows = await deps.db
    .select({ id: deadlines.id, credentialId: deadlines.attachmentId, kind: deadlines.kind })
    .from(deadlines)
    .where(eq(deadlines.recordId, providerId));
  const staleIds = existingRows.filter((r) => !computedKeys.has(deadlineKey(r))).map((r) => r.id);
  if (staleIds.length > 0) {
    await deps.db.delete(deadlines).where(inArray(deadlines.id, staleIds));
  }
  return { deadlines: computed.map((d) => ({ credential_id: d.credentialId, kind: d.kind, due_at: d.dueAt })) };
}

/**
 * `deadlines_upcoming`: this client's deadlines due inside the window, overdue
 * ones included, sorted by due date. The urgency bucket and the digest key come
 * from `compute.ts`; this function reads the rows they are computed from.
 */
export async function upcomingDeadlines(
  deps: ToolDeps,
  { window_days, today, limit }: UpcomingArgs,
): Promise<{ items: UpcomingItem[]; digest_key: string }> {
  const todayDate = today ? new Date(`${today}T00:00:00Z`) : deps.now();
  const todayStr = todayDate.toISOString().slice(0, 10);
  const horizon = addDays(todayStr, window_days);
  const rows = await deps.db
    .select({
      providerId: deadlines.recordId,
      providerName: records.name,
      credentialId: deadlines.attachmentId,
      credentialKind: attachments.kind,
      kind: deadlines.kind,
      dueAt: deadlines.dueAt,
    })
    .from(deadlines)
    .innerJoin(attachments, eq(deadlines.attachmentId, attachments.id))
    .innerJoin(records, eq(deadlines.recordId, records.id))
    .where(and(eq(records.client, deps.client), lte(deadlines.dueAt, horizon)))
    .orderBy(asc(deadlines.dueAt))
    .limit(limit);
  const items = rows.map((r) => {
    const daysLeft = daysUntil(r.dueAt, todayDate);
    return {
      provider_id: r.providerId,
      provider_name: r.providerName,
      credential_id: r.credentialId,
      credential_kind: r.credentialKind,
      kind: r.kind,
      due_at: r.dueAt,
      days_left: daysLeft,
      overdue: daysLeft < 0,
      bucket: bucketFor(daysLeft),
    };
  });
  const digest_key = digestKeyFor(
    items.map((i) => ({ credentialId: i.credential_id, kind: i.kind, bucket: i.bucket })),
  );
  return { items, digest_key };
}
