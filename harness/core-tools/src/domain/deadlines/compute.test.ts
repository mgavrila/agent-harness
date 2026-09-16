import { describe, it, expect } from 'vitest';
import { daysUntil, addDays, computeDeadlines, bucketFor, digestKeyFor } from './compute.js';

/**
 * The lead times the healthcare pack declares. They used to be a `LEAD_DAYS` table in
 * `compute.ts`; the calculator takes a lookup function now, so the fixture holds them.
 */
const LEAD = new Map([
  ['license', 90],
  ['dea', 90],
  ['malpractice', 60],
  ['board_cert', 120],
]);
const leadDaysFor = (kind: string) => LEAD.get(kind) ?? 0;

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
    const out = computeDeadlines(
      [
        { id: 'c1', kind: 'license', expiresAt: '2027-03-31' },
        { id: 'c2', kind: 'malpractice', expiresAt: '2026-11-30' },
        { id: 'c3', kind: 'dea', expiresAt: null },
      ],
      leadDaysFor,
    );
    expect(out).toEqual([
      { attachmentId: 'c1', kind: 'expiration', dueAt: '2027-03-31' },
      { attachmentId: 'c1', kind: 'renewal_start', dueAt: addDays('2027-03-31', -LEAD.get('license')!) },
      { attachmentId: 'c2', kind: 'expiration', dueAt: '2026-11-30' },
      { attachmentId: 'c2', kind: 'renewal_start', dueAt: addDays('2026-11-30', -LEAD.get('malpractice')!) },
    ]);
  });

  it('writes no renewal_start for a kind with no lead time, because it does not need renewing', () => {
    const out = computeDeadlines([{ id: 'a1', kind: 'source_link', expiresAt: '2027-01-01' }], () => 0);
    expect(out.map((d) => d.kind)).toEqual(['expiration']);
  });
});

describe('bucketFor', () => {
  it('buckets overdue below zero', () => {
    expect(bucketFor(-1)).toBe('overdue');
    expect(bucketFor(-90)).toBe('overdue');
  });

  it('buckets at the 7-day boundary', () => {
    expect(bucketFor(0)).toBe('due_7d');
    expect(bucketFor(7)).toBe('due_7d');
    expect(bucketFor(8)).toBe('due_30d');
  });

  it('buckets at the 30-day boundary', () => {
    expect(bucketFor(30)).toBe('due_30d');
    expect(bucketFor(31)).toBe('due_60d');
  });

  it('buckets at the 60-day boundary', () => {
    expect(bucketFor(60)).toBe('due_60d');
    expect(bucketFor(61)).toBe('due_90d');
  });
});

describe('digestKeyFor', () => {
  it('returns a fixed key for an empty list', () => {
    expect(digestKeyFor([])).toBe('expirations:none');
  });

  it('is stable regardless of item order', () => {
    const a = digestKeyFor([
      { attachmentId: 'c1', kind: 'expiration', bucket: 'due_7d' },
      { attachmentId: 'c2', kind: 'renewal_start', bucket: 'overdue' },
    ]);
    const b = digestKeyFor([
      { attachmentId: 'c2', kind: 'renewal_start', bucket: 'overdue' },
      { attachmentId: 'c1', kind: 'expiration', bucket: 'due_7d' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^expirations:[0-9a-f]{12}$/);
  });

  it('changes when an item moves to a different bucket', () => {
    const before = digestKeyFor([{ attachmentId: 'c1', kind: 'expiration', bucket: 'due_7d' }]);
    const after = digestKeyFor([{ attachmentId: 'c1', kind: 'expiration', bucket: 'due_30d' }]);
    expect(before).not.toBe(after);
  });
});
