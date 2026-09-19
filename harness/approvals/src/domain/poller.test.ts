import { describe, it, expect, vi } from 'vitest';
import { approvals, type Db } from '@harness/db';
import { SurfaceAcceptedError, SurfaceError } from '@harness/shared';
import type { Card, MessageRef } from '@harness/surface-api';
import { MemorySurface, pendingApproval, useTestDb } from '../testing.js';
import { postPendingApprovals, type PollResult } from './poller.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

/**
 * A database whose only broken operation is the `message_ref` write — a connection reset or a
 * statement timeout landing between the successful post and the row update. Every other query,
 * the claim included, runs for real, so the test exercises the true post-succeeded/write-failed
 * state rather than a simulation of it.
 */
function dbWithFailingMessageRefWrite(real: Db): Db {
  return {
    select: real.select.bind(real),
    update: (table: Parameters<Db['update']>[0]) => {
      const builder = real.update(table);
      return {
        set: (values: Record<string, unknown>) =>
          'messageRef' in values
            ? { where: () => Promise.reject(new Error('statement timeout')) }
            : builder.set(values),
      };
    },
  } as unknown as Db;
}

/**
 * A surface whose transport takes the card and then answers with nothing to address it by — the
 * Slack `ok` with no `ts`. The card is recorded first, because that is the state the adapter is
 * reporting: the message is live and only the reference is missing.
 */
class AcceptsWithoutReferenceSurface extends MemorySurface {
  accepting = true;

  override async postCard(conversation: string, card: Card): Promise<MessageRef> {
    const ref = await super.postCard(conversation, card);
    if (!this.accepting) return ref;
    throw new SurfaceAcceptedError('memory: the card was accepted without a reference');
  }
}

/** A surface that starts a second poll run in the middle of the first one's post. */
class RacingSurface extends MemorySurface {
  second: PollResult | undefined;
  private racing = false;

  override async postCard(conversation: string, card: Card): Promise<MessageRef> {
    if (!this.racing) {
      this.racing = true;
      // By the time this fires, the first run has already claimed the row but has not yet
      // posted, so a second poller starting here must see it as claimed and post nothing.
      this.second = await postPendingApprovals({ db, surface: this, client: 'demo-practice', now });
    }
    return super.postCard(conversation, card);
  }
}

/**
 * Another host's tick folded into this one's in-flight post. This poller claims the row and calls
 * `postCard`; while that call is still hanging, host B's stale sweep releases the claim, reclaims
 * the row under its own later `claimedAt` and starts its own post. Only then does this call
 * reject, so the release that follows must leave B's claim alone.
 */
class ReclaimedDuringPostSurface extends MemorySurface {
  static readonly reclaimedAt = new Date(now().getTime() + 2 * 60 * 1000);

  override async postCard(conversation: string): Promise<MessageRef> {
    await db.update(approvals).set({
      surface: this.name,
      conversationId: conversation,
      claimedAt: ReclaimedDuringPostSurface.reclaimedAt,
    });
    throw new SurfaceError(`${this.name}: conversation_not_found`);
  }
}

describe('postPendingApprovals', () => {
  it('posts one card per unposted pending approval and records where it went', async () => {
    await db.insert(approvals).values([pendingApproval(), pendingApproval({ idempotencyKey: 'k2' })]);
    const surface = new MemorySurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out).toMatchObject({ posted: 2, orphaned: 0 });
    expect(surface.cards).toHaveLength(2);
    expect(surface.cards[0].ref.conversation).toBe('memory');
    expect(surface.cards[0].card.title).toBe('Approval needed');
    const rows = await db.select().from(approvals);
    expect(rows.every((r) => r.messageRef !== null && r.conversationId === 'memory' && r.surface === 'memory')).toBe(
      true,
    );
  });

  it('posts nothing on a second pass', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new MemorySurface();
    const deps = { db, surface, client: 'demo-practice', now };
    await postPendingApprovals(deps);
    await postPendingApprovals(deps);
    expect(surface.cards).toHaveLength(1);
  });

  it('skips decided, expired and other-client rows', async () => {
    await db
      .insert(approvals)
      .values([
        pendingApproval({ status: 'approved' }),
        pendingApproval({ idempotencyKey: 'k2', expiresAt: new Date('2026-09-15T11:00:00Z') }),
        pendingApproval({ idempotencyKey: 'k3', client: 'other-clinic' }),
      ]);
    const surface = new MemorySurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out.posted).toBe(0);
    expect(surface.cards).toHaveLength(0);
  });

  it('releases the claim when the surface rejects the post outright, and posts it on the next run', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new MemorySurface();
    surface.failWith = 'conversation_not_found';
    const deps = { db, surface, client: 'demo-practice', now };
    const out1 = await postPendingApprovals(deps);
    expect(out1.posted).toBe(0);
    const [afterFailure] = await db.select().from(approvals);
    expect(afterFailure.conversationId).toBeNull();
    expect(afterFailure.messageRef).toBeNull();

    surface.failWith = undefined;
    const out2 = await postPendingApprovals(deps);
    expect(out2.posted).toBe(1);
    const [afterRetry] = await db.select().from(approvals);
    expect(afterRetry.conversationId).toBe('memory');
    expect(afterRetry.messageRef).not.toBeNull();
  });

  it('releases a stale claim (claimed more than 2 minutes ago) and posts it', async () => {
    const staleClaimedAt = new Date(now().getTime() - 3 * 60 * 1000);
    await db.insert(approvals).values(
      pendingApproval({
        surface: 'memory',
        conversationId: 'memory-stale',
        claimedAt: staleClaimedAt,
        createdAt: staleClaimedAt,
      }),
    );
    const surface = new MemorySurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out.posted).toBe(1);
    expect(surface.cards).toHaveLength(1);
    const [row] = await db.select().from(approvals);
    expect(row.conversationId).toBe('memory');
    expect(row.messageRef).not.toBeNull();
  });

  it('leaves a fresh claim on an old row alone: the window runs from the claim, not from creation', async () => {
    const createdLongAgo = new Date(now().getTime() - 30 * 60 * 1000);
    await db.insert(approvals).values(
      pendingApproval({
        surface: 'memory',
        conversationId: 'elsewhere',
        claimedAt: now(),
        createdAt: createdLongAgo,
      }),
    );
    const surface = new MemorySurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out.posted).toBe(0);
    expect(surface.cards).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row.conversationId).toBe('elsewhere');
    expect(row.messageRef).toBeNull();
  });

  it('keeps the claim when the post succeeded but recording message_ref failed, so the next tick posts nothing', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new MemorySurface();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out1 = await postPendingApprovals({
      db: dbWithFailingMessageRefWrite(db),
      surface,
      client: 'demo-practice',
      now,
    });
    // The card reached the surface; only the bookkeeping failed, so nothing counts as posted and
    // nothing is released.
    expect(out1.posted).toBe(0);
    expect(surface.cards).toHaveLength(1);
    const [afterWriteFailure] = await db.select().from(approvals);
    expect(afterWriteFailure.conversationId).toBe('memory');
    expect(afterWriteFailure.messageRef).toBeNull();

    // The next tick, on a healthy database, must not post a second card.
    const out2 = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out2).toMatchObject({ posted: 0, orphaned: 0 });
    expect(surface.cards).toHaveLength(1);

    errors.mockRestore();
  });

  it('keeps the claim when the surface accepted the card without a reference, so the next tick posts nothing', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new AcceptsWithoutReferenceSurface();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { db, surface, client: 'demo-practice', now };

    const out1 = await postPendingApprovals(deps);
    // A card is live with a working set of buttons, but there is no reference to record, so
    // nothing counts as posted and — unlike an outright rejection — nothing is released.
    expect(out1).toMatchObject({ posted: 0, orphaned: 0 });
    expect(surface.cards).toHaveLength(1);
    const [afterAccept] = await db.select().from(approvals);
    expect(afterAccept.surface).toBe('memory');
    expect(afterAccept.conversationId).toBe('memory');
    expect(afterAccept.messageRef).toBeNull();

    // The next tick, against a surface that now answers with a reference, must not post a second
    // card: the claim is what keeps the row out of the pending select until the stale sweep.
    surface.accepting = false;
    const out2 = await postPendingApprovals(deps);
    expect(out2).toMatchObject({ posted: 0, orphaned: 0 });
    expect(surface.cards).toHaveLength(1);

    errors.mockRestore();
  });

  it('produces exactly one post when a second poll run starts while the first is posting', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new RacingSurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(surface.second).toMatchObject({ posted: 0, orphaned: 0 });
    expect(out).toMatchObject({ posted: 1, orphaned: 0 });
    expect(surface.cards).toHaveLength(1);
  });

  it('releases only the claim it took, so a reclaim by another host survives a failed post', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new ReclaimedDuringPostSurface();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out1 = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(out1).toMatchObject({ posted: 0, orphaned: 0 });

    // The claim on the row is now the other host's, and its card is in flight: releasing it here
    // would strand a live card with no surface to edit it on.
    const [afterFailure] = await db.select().from(approvals);
    expect(afterFailure.claimedAt).toEqual(ReclaimedDuringPostSurface.reclaimedAt);
    expect(afterFailure.conversationId).not.toBeNull();
    expect(afterFailure.surface).not.toBeNull();

    // The other host's post lands and records its reference; a later tick posts nothing more.
    await db.update(approvals).set({ messageRef: 'm1' });
    const healthy = new MemorySurface();
    const out2 = await postPendingApprovals({ db, surface: healthy, client: 'demo-practice', now });
    expect(out2).toMatchObject({ posted: 0, orphaned: 0 });
    expect(healthy.cards).toHaveLength(0);

    errors.mockRestore();
  });
});
