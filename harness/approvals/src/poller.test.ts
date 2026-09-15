import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { postPendingApprovals } from './poller.js';
import { FakeSlack, useTestDb } from './testing.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

const base = {
  client: 'demo-practice',
  action: 'forms_release',
  payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
  summary: 'forms_release (external) requested by hermes',
  requestedBy: 'hermes',
};

describe('postPendingApprovals', () => {
  it('posts one card per unposted pending approval and records where it went', async () => {
    await db.insert(approvals).values([
      { ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') },
      { ...base, idempotencyKey: 'k2', expiresAt: new Date('2026-09-16T12:00:00Z') },
    ]);
    const slack = new FakeSlack();
    const out = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out).toMatchObject({ posted: 2, orphaned: 0 });
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[0].channel).toBe('C0DEMO');
    expect(slack.posts[0].text).toContain('Approval needed');
    const rows = await db.select().from(approvals);
    expect(rows.every((r) => r.slackTs !== null && r.slackChannel === 'C0DEMO')).toBe(true);
  });

  it('posts nothing on a second pass', async () => {
    await db.insert(approvals).values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') });
    const slack = new FakeSlack();
    const deps = { db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now };
    await postPendingApprovals(deps);
    await postPendingApprovals(deps);
    expect(slack.posts).toHaveLength(1);
  });

  it('skips decided, expired and other-client rows', async () => {
    await db.insert(approvals).values([
      { ...base, idempotencyKey: 'k1', status: 'approved', expiresAt: new Date('2026-09-16T12:00:00Z') },
      { ...base, idempotencyKey: 'k2', expiresAt: new Date('2026-09-15T11:00:00Z') },
      { ...base, idempotencyKey: 'k3', client: 'other-clinic', expiresAt: new Date('2026-09-16T12:00:00Z') },
    ]);
    const slack = new FakeSlack();
    const out = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out.posted).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });

  it('does not mark a row posted when Slack rejects the message', async () => {
    await db.insert(approvals).values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') });
    const slack = new FakeSlack();
    slack.failWith = 'channel_not_found';
    const out = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out.posted).toBe(0);
    const [row] = await db.select().from(approvals);
    expect(row.slackTs).toBeNull();
  });

  it('counts a card as orphaned when the row was decided while it was posting', async () => {
    const [inserted] = await db
      .insert(approvals)
      .values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') })
      .returning();
    const slack = new FakeSlack();
    const racing = {
      ...slack,
      chat: {
        update: slack.chat.update,
        postMessage: async (args: Parameters<typeof slack.chat.postMessage>[0]) => {
          // A human decides in the window between the post and the claim.
          await db.update(approvals).set({ status: 'declined' }).where(eq(approvals.id, inserted.id));
          return slack.chat.postMessage(args);
        },
      },
    };
    const out = await postPendingApprovals({ db, api: racing, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out).toMatchObject({ posted: 0, orphaned: 1 });
  });
});
