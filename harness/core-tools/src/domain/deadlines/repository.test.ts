import { describe, expect, it } from 'vitest';
import { attachments, deadlines } from '@harness/db';
import { eq } from 'drizzle-orm';
import { makeTestDeps, useTestDb } from '../../testing.js';
import { upsertRecord } from '../records/repository.js';
import { recomputeDeadlines, upcomingDeadlines } from './repository.js';

const db = useTestDb();

const provider = (over: Record<string, unknown> = {}) => ({
  kind: 'provider',
  name: 'Ada Reyes',
  external_id: '1234567890',
  fields: [],
  attachments: [{ kind: 'license', issuer: 'TX Medical Board', state: 'TX', expires_at: '2027-03-31' }],
  ...over,
});

describe('the tenant column on deadlines', () => {
  it('computes and lists deadlines for one tenant only', async () => {
    const alpha = makeTestDeps(db, { client: 'alpha' });
    const { record_id } = await upsertRecord(alpha, provider());
    const computed = await recomputeDeadlines(alpha, record_id);
    expect(computed.deadlines.length).toBeGreaterThan(0);
    const rows = await db.select().from(deadlines);
    expect(rows.every((r) => r.client === 'alpha')).toBe(true);

    const listed = await upcomingDeadlines(alpha, { within_days: 3650, limit: 20 });
    expect(listed.items.map((i) => i.record_id)).toEqual(rows.map(() => record_id));
  });

  it("lists none of, and retires none of, a row another tenant's writer left behind", async () => {
    const alpha = makeTestDeps(db, { client: 'alpha' });
    const { record_id } = await upsertRecord(alpha, provider());
    await recomputeDeadlines(alpha, record_id);
    const [attachment] = await db.select().from(attachments).where(eq(attachments.recordId, record_id));

    // A writer that was not correct: a deadline under alpha's record carrying another tenant's id.
    // The foreign key reaches alpha's record, so a listing that only joined would hand it back.
    await db.insert(deadlines).values({
      client: 'beta',
      recordId: record_id,
      attachmentId: attachment.id,
      kind: 'unfiled',
      dueAt: '2027-01-31',
    });

    const listed = await upcomingDeadlines(alpha, { within_days: 3650, limit: 20 });
    expect(listed.items.map((i) => i.kind)).not.toContain('unfiled');

    // And alpha's recompute retires what alpha's attachments no longer produce, not beta's row.
    await recomputeDeadlines(alpha, record_id);
    expect(await db.$count(deadlines, eq(deadlines.client, 'beta'))).toBe(1);
  });

  it('recomputes from its own attachments, not from every row under the record', async () => {
    const alpha = makeTestDeps(db, { client: 'alpha' });
    const { record_id } = await upsertRecord(alpha, provider({ attachments: [] }));
    await db
      .insert(attachments)
      .values({ client: 'beta', recordId: record_id, kind: 'license', expiresAt: '2027-03-31' });
    expect((await recomputeDeadlines(alpha, record_id)).deadlines).toEqual([]);
  });
});
