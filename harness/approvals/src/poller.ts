import { and, asc, eq, gt, isNull } from 'drizzle-orm';
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
  /** Cards that reached Slack but whose row had already moved on. */
  orphaned: number;
}

/**
 * Turn every pending approval that has no card yet into one.
 *
 * Posting happens before the row is claimed, because a Slack timestamp only
 * exists after the post. The claim is therefore guarded on the row still being
 * pending and unposted; when it is not, the card is counted orphaned and
 * logged rather than overwriting a decision that landed first.
 *
 * Run one approvals app per client. Two pollers against the same client would
 * each post a card in the window before either claims.
 */
export async function postPendingApprovals(deps: PollDeps, limit = 20): Promise<PollResult> {
  const now = deps.now();
  const pending = await deps.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.slackTs),
        gt(approvals.expiresAt, now),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(limit);

  const result: PollResult = { posted: 0, orphaned: 0 };
  for (const row of pending) {
    let ts: string | undefined;
    let channel = deps.channel;
    try {
      const res = await deps.api.chat.postMessage({
        channel: deps.channel,
        text: approvalFallbackText(row),
        blocks: approvalBlocks(row),
      });
      ts = res.ts;
      channel = res.channel ?? deps.channel;
    } catch (err) {
      console.error(`approvals: could not post the card for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!ts) {
      console.error(`approvals: Slack accepted the card for ${row.id} without a timestamp; leaving the row unposted`);
      continue;
    }

    const claimed = await deps.db
      .update(approvals)
      .set({ slackChannel: channel, slackTs: ts })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending'), isNull(approvals.slackTs)))
      .returning({ id: approvals.id });
    if (claimed.length === 0) {
      result.orphaned += 1;
      console.error(`approvals: card ${channel}/${ts} for ${row.id} is orphaned; the row changed while it was posting`);
      continue;
    }
    result.posted += 1;
  }
  return result;
}
