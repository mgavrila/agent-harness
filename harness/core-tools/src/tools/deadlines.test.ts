import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { credentials, deadlines } from '@harness/db';
import { connectTools, makeTestDeps, resultOf, useTestDb, type TestClient } from '../testing.js';
import { providerTools } from './providers.js';
import { deadlineTools } from './deadlines.js';

const db = useTestDb();
const deps = makeTestDeps(db, { now: () => new Date('2026-09-15T12:00:00Z') });

const connectDeadlines = () => connectTools('deadlines-test', [...providerTools, ...deadlineTools], deps);

interface ComputedDeadline {
  credential_id: string;
  kind: string;
  due_at: string;
}

interface UpcomingItem {
  provider_name: string;
  credential_kind: string;
  kind: string;
  due_at: string;
  days_left: number;
  overdue: boolean;
  bucket: string;
}

/** Create a provider with three credentials, and return its id. */
async function seed(client: TestClient) {
  const res = await client.callTool({
    name: 'providers_upsert',
    arguments: {
      name: 'Dr. Grace Hopper',
      npi: '1112223334',
      credentials: [
        { kind: 'license', state: 'NY', number: 'L1', expires_at: '2026-10-15' },
        { kind: 'dea', number: 'D1', expires_at: '2027-06-30' },
        { kind: 'malpractice', number: 'M1', expires_at: '2026-09-01' },
      ],
    },
  });
  return resultOf<{ provider_id: string }>(res).provider_id;
}

describe('deadlines tools', () => {
  it('compute writes one row per credential and kind, idempotently', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    const first = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect(resultOf<{ deadlines: unknown[] }>(first).deadlines).toHaveLength(6);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect(await db.select().from(deadlines)).toHaveLength(6);
  });

  it('compute rejects an unknown provider', async () => {
    const client = await connectDeadlines();
    const res = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: randomUUID() } });
    expect(res.isError).toBe(true);
  });

  it('upcoming returns items inside the window, flags overdue, sorted by due date', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    const { items } = resultOf<{ items: UpcomingItem[] }>(res);
    // today 2026-09-15: malpractice expiration 09-01 (overdue), malpractice renewal_start 07-03 (overdue),
    // license renewal_start 07-17 (overdue), license expiration 10-15 (30 days). DEA (2027-06-30, renewal 2027-04-01) is outside.
    expect(items.map((i) => `${i.credential_kind}:${i.kind}`)).toEqual([
      'malpractice:renewal_start',
      'license:renewal_start',
      'malpractice:expiration',
      'license:expiration',
    ]);
    expect(items[0].overdue).toBe(true);
    expect(items[3]).toMatchObject({ days_left: 30, overdue: false, provider_name: 'Dr. Grace Hopper' });
    expect(items.map((i) => i.bucket)).toEqual(['overdue', 'overdue', 'overdue', 'due_30d']);
  });

  it('upcoming includes a digest key that is stable across identical calls', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });

    const first = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    const { digest_key: firstKey } = resultOf<{ digest_key: string }>(first);
    expect(firstKey).toMatch(/^expirations:[0-9a-f]{12}$/);

    const second = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    expect(resultOf<{ digest_key: string }>(second).digest_key).toBe(firstKey);
  });

  it('upcoming returns expirations:none as the digest key when nothing is due', async () => {
    const client = await connectDeadlines();
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    const { items, digest_key } = resultOf<{ items: UpcomingItem[]; digest_key: string }>(res);
    expect(items).toHaveLength(0);
    expect(digest_key).toBe('expirations:none');
  });

  it('compute retires stale deadlines when a credential loses its expiry, preserving notifiedAt on survivors', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });

    const licenseCred = await db.query.credentials.findFirst({
      where: and(eq(credentials.recordId, id), eq(credentials.kind, 'license')),
    });
    if (!licenseCred) throw new Error('license credential missing');
    await db
      .update(deadlines)
      .set({ notifiedAt: new Date('2026-08-01T00:00:00Z') })
      .where(and(eq(deadlines.attachmentId, licenseCred.id), eq(deadlines.kind, 'expiration')));

    await client.callTool({
      name: 'providers_upsert',
      arguments: {
        name: 'Dr. Grace Hopper',
        npi: '1112223334',
        credentials: [{ kind: 'malpractice', number: 'M1' }],
      },
    });

    const second = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const secondDeadlines = resultOf<{ deadlines: ComputedDeadline[] }>(second).deadlines;
    expect(secondDeadlines).toHaveLength(4);

    const malpracticeCred = await db.query.credentials.findFirst({
      where: and(eq(credentials.recordId, id), eq(credentials.kind, 'malpractice')),
    });
    if (!malpracticeCred) throw new Error('malpractice credential missing');
    expect(secondDeadlines.every((d) => d.credential_id !== malpracticeCred.id)).toBe(true);

    const rows = await db.select().from(deadlines).where(eq(deadlines.recordId, id));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.attachmentId !== malpracticeCred.id)).toBe(true);

    const licenseExpiration = rows.find((r) => r.attachmentId === licenseCred.id && r.kind === 'expiration');
    expect(licenseExpiration?.notifiedAt).toBeTruthy();

    // Moving the due date invalidates the notification that was sent for the
    // old one, so the marker must be cleared.
    await client.callTool({
      name: 'providers_upsert',
      arguments: {
        name: 'Dr. Grace Hopper',
        npi: '1112223334',
        credentials: [{ kind: 'license', state: 'NY', number: 'L1', expires_at: '2027-01-31' }],
      },
    });
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const moved = (await db.select().from(deadlines).where(eq(deadlines.recordId, id))).find(
      (r) => r.attachmentId === licenseCred.id && r.kind === 'expiration',
    );
    expect(moved?.dueAt).toBe('2027-01-31');
    expect(moved?.notifiedAt).toBeNull();
  });

  it('upcoming caps the number of rows at limit', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90, limit: 2 } });
    const { items } = resultOf<{ items: UpcomingItem[] }>(res);
    expect(items).toHaveLength(2);
    const rejected = await client.callTool({ name: 'deadlines_upcoming', arguments: { limit: 0 } });
    expect(rejected.isError).toBe(true);
  });

  it('upcoming accepts an explicit today', async () => {
    const client = await connectDeadlines();
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({
      name: 'deadlines_upcoming',
      arguments: { window_days: 30, today: '2027-06-15' },
    });
    const { items } = resultOf<{ items: UpcomingItem[] }>(res);
    expect(items.some((i) => i.credential_kind === 'dea' && i.kind === 'expiration')).toBe(true);
  });
});
