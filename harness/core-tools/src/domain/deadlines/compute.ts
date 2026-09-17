import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

function toUtcMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMidnight(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysUntil(dueAt: string, today: Date): number {
  const todayMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((toUtcMidnight(dueAt) - todayMidnight) / DAY_MS);
}

export function addDays(dateStr: string, days: number): string {
  return fromUtcMidnight(toUtcMidnight(dateStr) + days * DAY_MS);
}

export interface AttachmentLike {
  id: string;
  kind: string;
  expiresAt: string | null;
}

export interface ComputedDeadline {
  attachmentId: string;
  kind: 'expiration' | 'renewal_start';
  dueAt: string;
}

/**
 * The expiration and renewal-start dates for a record's attachments.
 *
 * `leadDaysFor` comes from the loaded pack's `AttachmentKindSpec`: the kernel has no table of
 * lead times any more, because how long before a licence lapses someone should start renewing
 * it is the pack's knowledge, not the calculator's. **Zero lead days means no renewal-start
 * deadline at all**, which is the honest answer for an attachment kind that does not expire;
 * before this, an unknown kind silently got 90 days.
 */
export function computeDeadlines(items: AttachmentLike[], leadDaysFor: (kind: string) => number): ComputedDeadline[] {
  const out: ComputedDeadline[] = [];
  for (const a of items) {
    if (!a.expiresAt) continue;
    out.push({ attachmentId: a.id, kind: 'expiration', dueAt: a.expiresAt });
    const lead = leadDaysFor(a.kind);
    if (lead > 0) out.push({ attachmentId: a.id, kind: 'renewal_start', dueAt: addDays(a.expiresAt, -lead) });
  }
  return out;
}

export const URGENCY_BUCKETS = ['overdue', 'due_7d', 'due_30d', 'due_60d', 'due_90d'] as const;
export type UrgencyBucket = (typeof URGENCY_BUCKETS)[number];

/**
 * The urgency bucket a deadline falls in, by days remaining. Kept as a pure
 * function so a skill never re-derives it in prose: the boundary belongs to
 * the tool, once, and every caller reads the same answer.
 */
export function bucketFor(daysLeft: number): UrgencyBucket {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 7) return 'due_7d';
  if (daysLeft <= 30) return 'due_30d';
  if (daysLeft <= 60) return 'due_60d';
  return 'due_90d';
}

interface DigestKeyItem {
  attachmentId: string;
  kind: string;
  /**
   * The urgency bucket, as a plain string rather than `UrgencyBucket`.
   *
   * Every producer today goes through `bucketFor`, but the only thing this function does with
   * the value is interpolate it into the hashed line, so nothing here depends on the union — and
   * the caller reading a bucket back off a result type that declares it `string` was casting it
   * to `never` to get past the narrower declaration. A `string` here is what is actually true.
   */
  bucket: string;
}

/**
 * A key that identifies the exact set of (attachment, deadline kind, bucket) triples behind a
 * digest, independent of the order the items were listed in. Unchanged inputs reproduce the same
 * key, so `harness_notify` treats a re-run as the same digest; an item moving into a different
 * bucket changes at least one triple and so changes the key, which is exactly the signal a
 * playbook needs to speak again.
 *
 * **The hashed string and the `expirations:` prefix are unchanged from the credential-keyed
 * version, and migration 0008 preserved every credential id as its attachment id.** That is what
 * stops every playbook speaking again on the first run after the migration.
 */
export function digestKeyFor(items: DigestKeyItem[]): string {
  if (items.length === 0) return 'expirations:none';
  const lines = items.map((i) => `${i.attachmentId}:${i.kind}:${i.bucket}`).sort();
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
  return `expirations:${hash}`;
}
