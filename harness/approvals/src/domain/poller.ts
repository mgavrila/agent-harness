import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { createLogger } from '@harness/shared';
import type { SlackApi } from './slack/types.js';
import { approvalBlocks, approvalFallbackText } from './render/blocks.js';

const log = createLogger('approvals');

export interface PollDeps {
  db: Db;
  api: SlackApi;
  client: string;
  channel: string;
  now: () => Date;
}

export interface PollResult {
  posted: number;
  /** A row this run could not claim: another poller already had it. */
  orphaned: number;
}

/**
 * A claim with no `slack_ts` older than this is assumed abandoned (a poller
 * crashed, or its process was killed, between claiming and posting) and is
 * released so the row can be tried again. The window is measured from
 * `claimed_at`, so a row that was already old when first claimed is not
 * mistaken for a stale claim on the very next tick. Nothing claims a row before
 * a poller has actually picked it up.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Turn every pending approval that has no card yet into one.
 *
 * `slack_channel` doubles as the claim marker: a poller claims a row by
 * setting it to its own channel *before* calling Slack, guarded on the row
 * still being pending and unclaimed (`slack_channel IS NULL`). Only one
 * concurrent claim on the same row can win that guard, so two pollers can
 * never both post a card for it — the loser's claim affects zero rows and the
 * row is left for the winner or a later run. Posting happens only after a
 * successful claim; `slack_ts` is written on success, and a failed post
 * releases the claim (`slack_channel` back to null) so the row stays postable
 * on the next run instead of being stranded.
 *
 * Only a *failed post* releases the claim. If the post succeeds and writing
 * `slack_ts` is what fails, the claim stays: the card is already in the
 * channel, and releasing it would post a second one on the very next tick.
 * That row is then recovered by the stale sweep below rather than at once.
 *
 * Because there is no separate "claim expired but the process died before it
 * could release" signal, this run first releases any claim whose `claimed_at`
 * is older than `STALE_CLAIM_MS` and that never got a `slack_ts`.
 */
export async function postPendingApprovals(deps: PollDeps, limit = 20): Promise<PollResult> {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  await deps.db
    .update(approvals)
    .set({ slackChannel: null, claimedAt: null })
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.slackTs),
        isNotNull(approvals.slackChannel),
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
        isNull(approvals.slackTs),
        isNull(approvals.slackChannel),
        gt(approvals.expiresAt, now),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(limit);

  const result: PollResult = { posted: 0, orphaned: 0 };
  for (const row of pending) {
    const claimed = await deps.db
      .update(approvals)
      .set({ slackChannel: deps.channel, claimedAt: now })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending'), isNull(approvals.slackChannel)))
      .returning({ id: approvals.id });
    if (claimed.length === 0) {
      // Another poller claimed it between our select and our claim attempt.
      result.orphaned += 1;
      continue;
    }

    // Two separate try blocks, because the right recovery differs on each
    // side of the post. Before it, nothing reached Slack, so the claim is
    // released and the next tick retries immediately. After it, a card is
    // live in the channel: releasing the claim there would put a second card
    // with a second set of working buttons next to it on the next tick.
    let postResult: Awaited<ReturnType<typeof deps.api.chat.postMessage>>;
    try {
      postResult = await deps.api.chat.postMessage({
        channel: deps.channel,
        text: approvalFallbackText(row),
        blocks: approvalBlocks(row),
      });
    } catch (err) {
      log.error(`could not post the card for ${row.id}`, err);
      await deps.db
        .update(approvals)
        .set({ slackChannel: null, claimedAt: null })
        .where(and(eq(approvals.id, row.id), isNull(approvals.slackTs)));
      continue;
    }

    try {
      // A missing timestamp belongs on this side of the split: Slack answered,
      // so the card is in the channel even though we cannot record where.
      if (!postResult.ts) throw new Error('Slack accepted the message without a timestamp');
      await deps.db.update(approvals).set({ slackTs: postResult.ts }).where(eq(approvals.id, row.id));
      result.posted += 1;
    } catch (err) {
      // Deliberately no release. The row stays claimed with no slack_ts, and
      // the stale-claim sweep above picks it up after STALE_CLAIM_MS — late
      // enough for a transient database failure to have been noticed.
      log.error(
        `posted the card for ${row.id} but could not record its timestamp; ` +
          `leaving the claim in place so no duplicate is posted`,
        err,
      );
    }
  }
  return result;
}
