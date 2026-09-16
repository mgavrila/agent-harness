import { createHash } from 'node:crypto';

/**
 * The credential vocabulary, defined once for the whole package: the storage
 * contract (`CredentialInput.kind`), the form-template manifest, the
 * model-facing extraction schema and the lead-day table below all read it from
 * here. This module is the home because it is the only leaf with no harness
 * imports of its own, so every one of those can depend on it without a cycle.
 *
 * Four copies of this list used to sit in four files. A kind added to the
 * extraction schema but not to the manifest is a credential a model reports and
 * a template can never quote, and nothing fails loudly when the lists drift.
 */
export const CREDENTIAL_KINDS = ['license', 'dea', 'malpractice', 'board_cert'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const LEAD_DAYS: Record<CredentialKind, number> = {
  license: 90,
  dea: 90,
  malpractice: 60,
  board_cert: 120,
};

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

export interface CredentialLike {
  id: string;
  kind: string;
  expiresAt: string | null;
}

export interface ComputedDeadline {
  credentialId: string;
  kind: 'expiration' | 'renewal_start';
  dueAt: string;
}

export function computeDeadlines(creds: CredentialLike[]): ComputedDeadline[] {
  const out: ComputedDeadline[] = [];
  for (const c of creds) {
    if (!c.expiresAt) continue;
    const lead = LEAD_DAYS[c.kind as CredentialKind] ?? 90;
    out.push({ credentialId: c.id, kind: 'expiration', dueAt: c.expiresAt });
    out.push({ credentialId: c.id, kind: 'renewal_start', dueAt: addDays(c.expiresAt, -lead) });
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

export interface DigestKeyItem {
  credentialId: string;
  kind: string;
  bucket: UrgencyBucket;
}

/**
 * A key that identifies the exact set of (credential, deadline kind, bucket)
 * triples behind a digest, independent of the order the items were listed in.
 * Unchanged inputs reproduce the same key, so `harness_notify` treats a
 * re-run as the same digest; an item moving into a different bucket changes
 * at least one triple and so changes the key, which is exactly the signal a
 * playbook needs to speak again.
 */
export function digestKeyFor(items: DigestKeyItem[]): string {
  if (items.length === 0) return 'expirations:none';
  const lines = items.map((i) => `${i.credentialId}:${i.kind}:${i.bucket}`).sort();
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
  return `expirations:${hash}`;
}
