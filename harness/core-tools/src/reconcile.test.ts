import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, toolEffects, type Db } from '@harness/db';
import { reconcile } from './reconcile.js';
import { openTestDb } from './testing.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
const now = () => new Date('2026-09-15T12:00:00Z');

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

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
    const out = await reconcile(db, { now });
    expect(out.approvals_expired).toBe(2);
    const rows = await db.select().from(approvals);
    const byKey = Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.status]));
    expect(byKey).toEqual({ k1: 'expired', k2: 'expired', k3: 'pending', k4: 'declined', k5: 'executed' });
  });

  it('parks dispatching effects older than the stale window as needs_review', async () => {
    const base = { client: 'test', tool: 't', sink: 'slack', payloadEncrypted: Buffer.from('x'), summary: 's' };
    await db.insert(toolEffects).values([
      { ...base, idempotencyKey: 'old', status: 'dispatching', updatedAt: new Date('2026-09-15T11:30:00Z') },
      { ...base, idempotencyKey: 'fresh', status: 'dispatching', updatedAt: new Date('2026-09-15T11:58:00Z') },
      { ...base, idempotencyKey: 'staged', status: 'staged', updatedAt: new Date('2026-09-15T11:00:00Z') },
    ]);
    const out = await reconcile(db, { now, staleAfterMs: 10 * 60_000 });
    expect(out.dispatches_parked).toBe(1);
    const [old] = await db.select().from(toolEffects).where(eq(toolEffects.idempotencyKey, 'old'));
    expect(old.status).toBe('needs_review');
    const [fresh] = await db.select().from(toolEffects).where(eq(toolEffects.idempotencyKey, 'fresh'));
    expect(fresh.status).toBe('dispatching');
  });
});
