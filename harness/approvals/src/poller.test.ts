import { describe, it, expect, vi } from 'vitest';
import { approvals, type Db } from '@harness/db';
import { postPendingApprovals } from './poller.js';
import { FakeSlack, useTestDb } from './testing.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

/**
 * A database whose only broken operation is the `slack_ts` write — a
 * connection reset or a statement timeout landing between the successful
 * postMessage and the row update. Every other query, the claim included, runs
 * for real, so the test exercises the true post-succeeded/write-failed state
 * rather than a simulation of it.
 */
function dbWithFailingSlackTsWrite(real: Db): Db {
  return {
    select: real.select.bind(real),
    update: (table: Parameters<Db['update']>[0]) => {
      const builder = real.update(table);
      return {
        set: (values: Record<string, unknown>) =>
          'slackTs' in values
            ? { where: () => Promise.reject(new Error('statement timeout')) }
            : builder.set(values as never),
      };
    },
  } as unknown as Db;
}

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

  it('releases the claim when Slack rejects the post, and posts it on the next run', async () => {
    await db.insert(approvals).values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') });
    const slack = new FakeSlack();
    slack.failWith = 'channel_not_found';
    const deps = { db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now };
    const out1 = await postPendingApprovals(deps);
    expect(out1.posted).toBe(0);
    const [afterFailure] = await db.select().from(approvals);
    expect(afterFailure.slackChannel).toBeNull();
    expect(afterFailure.slackTs).toBeNull();

    slack.failWith = undefined;
    const out2 = await postPendingApprovals(deps);
    expect(out2.posted).toBe(1);
    const [afterRetry] = await db.select().from(approvals);
    expect(afterRetry.slackChannel).toBe('C0DEMO');
    expect(afterRetry.slackTs).not.toBeNull();
  });

  it('releases a stale claim (claimed more than 2 minutes ago) and posts it', async () => {
    const staleClaimedAt = new Date(now().getTime() - 3 * 60 * 1000);
    await db.insert(approvals).values({
      ...base,
      idempotencyKey: 'k1',
      expiresAt: new Date('2026-09-16T12:00:00Z'),
      slackChannel: 'C0STALE',
      claimedAt: staleClaimedAt,
      createdAt: staleClaimedAt,
    });
    const slack = new FakeSlack();
    const out = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out.posted).toBe(1);
    expect(slack.posts).toHaveLength(1);
    const [row] = await db.select().from(approvals);
    expect(row.slackChannel).toBe('C0DEMO');
    expect(row.slackTs).not.toBeNull();
  });

  it('leaves a fresh claim on an old row alone: the window runs from the claim, not from creation', async () => {
    const createdLongAgo = new Date(now().getTime() - 30 * 60 * 1000);
    await db.insert(approvals).values({
      ...base,
      idempotencyKey: 'k1',
      expiresAt: new Date('2026-09-16T12:00:00Z'),
      slackChannel: 'C0OTHER',
      claimedAt: now(),
      createdAt: createdLongAgo,
    });
    const slack = new FakeSlack();
    const out = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out.posted).toBe(0);
    expect(slack.posts).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row.slackChannel).toBe('C0OTHER');
    expect(row.slackTs).toBeNull();
  });

  it('keeps the claim when the post succeeded but recording slack_ts failed, so the next tick posts nothing', async () => {
    await db.insert(approvals).values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') });
    const slack = new FakeSlack();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out1 = await postPendingApprovals({
      db: dbWithFailingSlackTsWrite(db),
      api: slack,
      client: 'demo-practice',
      channel: 'C0DEMO',
      now,
    });
    // The card reached Slack; only the bookkeeping failed, so nothing counts
    // as posted and nothing is released.
    expect(out1.posted).toBe(0);
    expect(slack.posts).toHaveLength(1);
    const [afterWriteFailure] = await db.select().from(approvals);
    expect(afterWriteFailure.slackChannel).toBe('C0DEMO');
    expect(afterWriteFailure.slackTs).toBeNull();

    // The next tick, on a healthy database, must not post a second card.
    const out2 = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(out2).toMatchObject({ posted: 0, orphaned: 0 });
    expect(slack.posts).toHaveLength(1);

    errors.mockRestore();
  });

  it('produces exactly one post when a second poll run starts while the first is posting', async () => {
    await db.insert(approvals).values({ ...base, idempotencyKey: 'k1', expiresAt: new Date('2026-09-16T12:00:00Z') });
    const slack = new FakeSlack();
    let secondRun: Awaited<ReturnType<typeof postPendingApprovals>> | undefined;
    const racing = {
      ...slack,
      chat: {
        update: slack.chat.update,
        postEphemeral: slack.chat.postEphemeral,
        postMessage: async (args: Parameters<typeof slack.chat.postMessage>[0]) => {
          // By the time this fires, the first run has already claimed the row
          // (set slack_channel) but has not yet posted, so a second poller
          // starting here must see it as already claimed and post nothing.
          secondRun = await postPendingApprovals({ db, api: slack, client: 'demo-practice', channel: 'C0DEMO', now });
          return slack.chat.postMessage(args);
        },
      },
    };
    const out = await postPendingApprovals({ db, api: racing, client: 'demo-practice', channel: 'C0DEMO', now });
    expect(secondRun).toMatchObject({ posted: 0, orphaned: 0 });
    expect(out).toMatchObject({ posted: 1, orphaned: 0 });
    expect(slack.posts).toHaveLength(1);
  });
});
