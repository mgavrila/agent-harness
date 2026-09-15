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
