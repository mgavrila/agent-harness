import { and, eq, gt } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { createLogger, describeError } from '@harness/shared';
import type { SlackApi } from './slack/types.js';
import type { CoreToolsClient, ExecuteOutcome } from './execute/types.js';
import { decidedBlocks } from './render/blocks.js';
import type { ApprovalRow } from './render/types.js';

const log = createLogger('approvals');

export interface DecisionDeps {
  db: Db;
  api: SlackApi;
  core: CoreToolsClient;
  client: string;
  now: () => Date;
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'declined';
  decidedBy: string;
  note?: string;
}

export type DecisionResult =
  { outcome: 'not_actionable' } | { outcome: 'decided'; status: 'approved' | 'declined'; execution?: ExecuteOutcome };

/** A human-written note may contain anything; the same guard as the card applies. */
function safeText(text: string | null): string | null {
  if (!text) return null;
  return containsRestrictedPattern(text) ? '(withheld: it did not pass the redaction check)' : text;
}

/**
 * The thread reply Hermes reads as a new turn. It reports what already
 * happened — the app executes before replying — so the agent never has to
 * guess, and never says an action succeeded while it is still pending.
 */
export function threadReplyText(row: ApprovalRow, execution?: ExecuteOutcome): string {
  const who = `<@${row.decidedBy ?? 'unknown'}>`;
  if (row.status === 'approved') {
    if (execution?.status === 'executed') {
      return `Approval ${row.id} approved by ${who}. Executed \`${execution.tool}\`; delivery is queued in the effects outbox.`;
    }
    const reason = safeText(execution?.status === 'failed' ? execution.error : null) ?? 'see the audit log';
    return `Approval ${row.id} approved by ${who}, but execution failed: ${reason}. Nothing was sent.`;
  }
  const note = safeText(row.decisionNote);
  const tail = note ? ` Note: ${note}` : '';
  return `Approval ${row.id} declined by ${who}. Nothing was sent. Redo the action with the correction and request approval again.${tail}`;
}

/** Slack is best effort: a decision that is recorded must not be lost to a failed post. */
async function tellSlack(deps: DecisionDeps, row: ApprovalRow, execution: ExecuteOutcome | undefined): Promise<void> {
  if (!row.slackChannel || !row.slackTs) {
    log.warn(`${row.id} has no card to update; the decision is recorded but not shown in Slack`);
    return;
  }
  const outcome = {
    executed: execution?.status === 'executed',
    tool: execution?.status === 'executed' ? execution.tool : undefined,
    error: execution?.status === 'failed' ? execution.error : undefined,
  };
  try {
    await deps.api.chat.update({
      channel: row.slackChannel,
      ts: row.slackTs,
      text: `Approval ${row.id} ${row.status}`,
      blocks: decidedBlocks(row, outcome),
    });
  } catch (err) {
    log.error(`could not edit the card for ${row.id}`, err);
  }
  try {
    await deps.api.chat.postMessage({
      channel: row.slackChannel,
      thread_ts: row.slackTs,
      text: threadReplyText(row, execution),
    });
  } catch (err) {
    log.error(`could not post the thread reply for ${row.id}`, err);
  }
}

/**
 * Record a human decision and, when it is an approval, run the parked action.
 *
 * This function is the only writer of `approvals.status` outside the core
 * tools themselves. The transition is one guarded UPDATE, so two people
 * clicking at once produce one decision and one execution; the loser gets
 * `not_actionable`.
 */
export async function decideApproval(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult> {
  const now = deps.now();
  const [row] = await deps.db
    .update(approvals)
    .set({
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedAt: now,
      decisionNote: input.note ?? null,
    })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, now),
      ),
    )
    .returning();
  if (!row) return { outcome: 'not_actionable' };

  let execution: ExecuteOutcome | undefined;
  if (input.decision === 'approved') {
    try {
      execution = await deps.core.execute(row.id);
    } catch (err) {
      execution = { status: 'failed', error: describeError(err) };
    }
  }

  await tellSlack(deps, row, execution);
  return { outcome: 'decided', status: input.decision, execution };
}
