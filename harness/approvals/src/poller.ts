import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import type { SlackApi } from './slack.js';
import { approvalBlocks, approvalFallbackText } from './render.js';

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
 * released so the row can be tried again. There is no `claimed_at` column, so
 * `created_at` stands in for it; a row can therefore sit unclaimed for up to
 * this long after creation before its first claim attempt without being
 * mistaken for a stale claim, which is fine since nothing claims a row before
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
 * Because there is no separate "claim expired but the process died before it
 * could release" signal, this run first releases any claim older than
 * `STALE_CLAIM_MS` that never got a `slack_ts`, using `created_at` as the
 * stand-in for a claim timestamp.
 */
export async function postPendingApprovals(deps: PollDeps, limit = 20): Promise<PollResult> {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  await deps.db
    .update(approvals)
    .set({ slackChannel: null })
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.slackTs),
        isNotNull(approvals.slackChannel),
        lte(approvals.createdAt, staleBefore),
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
      .set({ slackChannel: deps.channel })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending'), isNull(approvals.slackChannel)))
      .returning({ id: approvals.id });
    if (claimed.length === 0) {
      // Another poller claimed it between our select and our claim attempt.
      result.orphaned += 1;
      continue;
    }

    try {
      const res = await deps.api.chat.postMessage({
        channel: deps.channel,
        text: approvalFallbackText(row),
        blocks: approvalBlocks(row),
      });
      if (!res.ts) throw new Error('Slack accepted the message without a timestamp');
      await deps.db.update(approvals).set({ slackTs: res.ts }).where(eq(approvals.id, row.id));
      result.posted += 1;
    } catch (err) {
      console.error(`approvals: could not post the card for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      await deps.db
        .update(approvals)
        .set({ slackChannel: null })
        .where(and(eq(approvals.id, row.id), isNull(approvals.slackTs)));
    }
  }
  return result;
}
