import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { approvals, toolEffects } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { reconcile } from './reconcile.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

describe('reconcile', () => {
  it('expires pending and approved rows past expiry, leaves live and decided rows alone', async () => {
    const base = { client: 'test', action: 't', payload: {}, summary: 's', requestedBy: 'r' };
    await db.insert(approvals).values([
      { ...base, idempotencyKey: 'k1', status: 'pending', expiresAt: new Date('2026-09-15T11:59:00Z') },
      { ...base, idempotencyKey: 'k2', status: 'approved', expiresAt: new Date('2026-09-15T11:00:00Z') },
      { ...base, idempotencyKey: 'k3', status: 'pending', expiresAt: new Date('2026-09-16T12:00:00Z') },
      { ...base, idempotencyKey: 'k4', status: 'declined', expiresAt: new Date('2026-09-15T11:00:00Z') },
      { ...base, idempotencyKey: 'k5', status: 'executed', expiresAt: new Date('2026-09-15T11:00:00Z') },
    ]);
    const out = await reconcile(db, { now, client: 'test' });
    expect(out.approvals_expired).toBe(2);
    const rows = await db.select().from(approvals);
    const byKey = Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.status]));
    expect(byKey).toEqual({ k1: 'expired', k2: 'expired', k3: 'pending', k4: 'declined', k5: 'executed' });
  });

  it("repairs one tenant's rows and leaves the other's alone", async () => {
    // Two expired pending approvals, one per client. There is no unscoped repair to fall back on:
    // a pooled host that ran one would expire a tenant's approvals because another restarted.
    for (const client of ['alpha', 'beta']) {
      await db.insert(approvals).values({
        client,
        action: 'forms_release',
        payload: {},
        summary: 's',
        requestedBy: 'u-one',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
        idempotencyKey: `k-${client}`,
      });
    }
    const repaired = await reconcile(db, { now, client: 'alpha' });
    expect(repaired.approvals_expired).toBe(1);
    expect(await db.$count(approvals, and(eq(approvals.client, 'beta'), eq(approvals.status, 'pending')))).toBe(1);
    expect(await db.$count(approvals, and(eq(approvals.client, 'alpha'), eq(approvals.status, 'expired')))).toBe(1);
  });

  it("parks only the given client's stuck dispatches when one is passed", async () => {
    const base = {
      tool: 't',
      sink: 'test_sink',
      payloadEncrypted: Buffer.from('x'),
      summary: 's',
      status: 'dispatching',
      updatedAt: new Date('2026-09-15T11:30:00Z'),
    };
    await db.insert(toolEffects).values([
      { ...base, client: 'test', idempotencyKey: 'mine' },
      { ...base, client: 'other-clinic', idempotencyKey: 'theirs' },
    ]);

    const scoped = await reconcile(db, { now, client: 'test' });
    expect(scoped.dispatches_parked).toBe(1);
    const rows = await db.select().from(toolEffects);
    expect(Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.status]))).toEqual({
      mine: 'needs_review',
      theirs: 'dispatching',
    });
  });

  it('parks dispatching effects older than the stale window as needs_review', async () => {
    const base = { client: 'test', tool: 't', sink: 'test_sink', payloadEncrypted: Buffer.from('x'), summary: 's' };
    await db.insert(toolEffects).values([
      { ...base, idempotencyKey: 'old', status: 'dispatching', updatedAt: new Date('2026-09-15T11:30:00Z') },
      { ...base, idempotencyKey: 'fresh', status: 'dispatching', updatedAt: new Date('2026-09-15T11:58:00Z') },
      { ...base, idempotencyKey: 'staged', status: 'staged', updatedAt: new Date('2026-09-15T11:00:00Z') },
    ]);
    const out = await reconcile(db, { now, client: 'test', staleAfterMs: 10 * 60_000 });
    expect(out.dispatches_parked).toBe(1);
    const [old] = await db.select().from(toolEffects).where(eq(toolEffects.idempotencyKey, 'old'));
    expect(old.status).toBe('needs_review');
    const [fresh] = await db.select().from(toolEffects).where(eq(toolEffects.idempotencyKey, 'fresh'));
    expect(fresh.status).toBe('dispatching');
    const [staged] = await db.select().from(toolEffects).where(eq(toolEffects.idempotencyKey, 'staged'));
    expect(staged.status).toBe('staged');
  });
});
