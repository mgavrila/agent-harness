import { describe, it, expect } from 'vitest';
import { daysUntil, addDays, computeDeadlines, LEAD_DAYS } from './compute.js';

describe('deadline math', () => {
  it('daysUntil counts UTC calendar days', () => {
    expect(daysUntil('2026-09-20', new Date('2026-09-15T23:59:00Z'))).toBe(5);
    expect(daysUntil('2026-09-15', new Date('2026-09-15T00:00:00Z'))).toBe(0);
    expect(daysUntil('2026-09-10', new Date('2026-09-15T12:00:00Z'))).toBe(-5);
  });

  it('addDays handles month ends and leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-31', -90)).toBe('2025-12-31');
  });

  it('computeDeadlines produces expiration and renewal_start per credential with an expiry', () => {
    const out = computeDeadlines([
      { id: 'c1', kind: 'license', expiresAt: '2027-03-31' },
      { id: 'c2', kind: 'malpractice', expiresAt: '2026-11-30' },
      { id: 'c3', kind: 'dea', expiresAt: null },
    ]);
    expect(out).toEqual([
      { credentialId: 'c1', kind: 'expiration', dueAt: '2027-03-31' },
      { credentialId: 'c1', kind: 'renewal_start', dueAt: addDays('2027-03-31', -LEAD_DAYS.license) },
      { credentialId: 'c2', kind: 'expiration', dueAt: '2026-11-30' },
      { credentialId: 'c2', kind: 'renewal_start', dueAt: addDays('2026-11-30', -LEAD_DAYS.malpractice) },
    ]);
  });
});
