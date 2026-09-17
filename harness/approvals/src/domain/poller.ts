import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { createLogger } from '@harness/shared';
import type { SurfaceSession } from '@harness/surface-api';
import { approvalCard } from './cards.js';

const log = createLogger('approvals');

export interface PollDeps {
  db: Db;
  /** Where cards are posted: the primary surface. */
  surface: SurfaceSession;
  client: string;
  now: () => Date;
}

export interface PollResult {
  posted: number;
  /** A row this run could not claim: another poller already had it. */
  orphaned: number;
}

/**
 * A claim with no `message_ref` older than this is assumed abandoned (a poller crashed, or its
 * process was killed, between claiming and posting) and is released so the row can be tried
 * again. The window is measured from `claimed_at`, so a row that was already old when first
 * claimed is not mistaken for a stale claim on the very next tick.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Turn every pending approval that has no card yet into one.
 *
 * `conversation_id` doubles as the claim marker: a poller claims a row by setting it *before*
 * calling the surface, guarded on the row still being pending and unclaimed
 * (`conversation_id IS NULL`). Only one concurrent claim on the same row can win that guard, so
 * two pollers can never both post a card for it — the loser's claim affects zero rows and the row
 * is left for the winner or a later run. Posting happens only after a successful claim;
 * `message_ref` is written on success, and a failed post releases the claim so the row stays
 * postable on the next run instead of being stranded.
 *
 * Only a *failed post* releases the claim. If the post succeeds and writing `message_ref` is what
 * fails, the claim stays: the card is already in the conversation, and releasing it would post a
 * second one on the very next tick. That row is then recovered by the stale sweep below rather
 * than at once.
 */
export async function postPendingApprovals(deps: PollDeps, limit = 20): Promise<PollResult> {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  await deps.db
    .update(approvals)
    .set({ surface: null, conversationId: null, claimedAt: null })
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.messageRef),
        isNotNull(approvals.conversationId),
        lte(approvals.claimedAt, staleBefore),
      ),
    );

  const pending = await deps.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.messageRef),
        isNull(approvals.conversationId),
        gt(approvals.expiresAt, now),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(limit);

  const result: PollResult = { posted: 0, orphaned: 0 };
  const conversation = deps.surface.defaultConversation;
  for (const row of pending) {
    const claimed = await deps.db
      .update(approvals)
      .set({ surface: deps.surface.name, conversationId: conversation, claimedAt: now })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending'), isNull(approvals.conversationId)))
      .returning({ id: approvals.id });
    if (claimed.length === 0) {
      // Another poller claimed it between our select and our claim attempt.
      result.orphaned += 1;
      continue;
    }

    // Two separate try/catch pairs, because the right recovery differs on each side of the post.
    // Before it, nothing was sent, so the claim is released and the next tick retries
    // immediately. After it, a card is live: releasing the claim there would put a second card
    // with a second set of working buttons next to it on the next tick.
    let ref: Awaited<ReturnType<typeof deps.surface.postCard>>;
    try {
      ref = await deps.surface.postCard(conversation, approvalCard(row, deps.surface.capabilities));
    } catch (err) {
      log.error(`could not post the card for ${row.id}`, err);
      await deps.db
        .update(approvals)
        .set({ surface: null, conversationId: null, claimedAt: null })
        .where(and(eq(approvals.id, row.id), isNull(approvals.messageRef)));
      continue;
    }

    try {
      await deps.db.update(approvals).set({ messageRef: ref.id }).where(eq(approvals.id, row.id));
      result.posted += 1;
    } catch (err) {
      // Deliberately no release. The row stays claimed with no message_ref, and the stale-claim
      // sweep above picks it up after STALE_CLAIM_MS — late enough for a transient database
      // failure to have been noticed.
      log.error(
        `posted the card for ${row.id} but could not record its message reference; ` +
          `leaving the claim in place so no duplicate is posted`,
        err,
      );
    }
  }
  return result;
}
