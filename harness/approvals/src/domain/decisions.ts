import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { createLogger, describeError } from '@harness/shared';
import type { MessageRef } from '@harness/surface-api';
import type { CoreToolsClient, ExecuteOutcome } from './execute/types.js';
import { decidedCard, type ApprovalRow } from './cards.js';
import type { LoadedSurfaces } from './surfaces/registry.js';

const log = createLogger('approvals');

export interface DecisionDeps {
  db: Db;
  surfaces: LoadedSurfaces;
  core: CoreToolsClient;
  client: string;
  now: () => Date;
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'declined';
  decidedBy: string;
  /** The surface the decision arrived on. It has to be the one the card was posted to. */
  surface: string;
  note?: string;
}

export type DecisionResult =
  | { outcome: 'not_actionable' }
  | { outcome: 'wrong_surface' }
  | { outcome: 'decided'; status: 'approved' | 'declined'; execution?: ExecuteOutcome };

/** A human-written note may contain anything; the same guard as the card applies. */
function safeText(text: string | null): string | null {
  if (!text) return null;
  return containsRestrictedPattern(text) ? '(withheld: it did not pass the redaction check)' : text;
}

/**
 * The reply Hermes reads as a new turn. It reports what already happened — the host executes
 * before replying — so the agent never has to guess, and never says an action succeeded while it
 * is still pending. `mention` comes from the surface it will be posted on: only that surface
 * knows how it spells one.
 */
export function threadReplyText(
  row: ApprovalRow,
  mention: (userId: string) => string,
  execution?: ExecuteOutcome,
): string {
  const who = mention(row.decidedBy ?? 'unknown');
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

/** Telling a human is best effort: a decision that is recorded must not be lost to a failed post. */
async function tellSurface(deps: DecisionDeps, row: ApprovalRow, execution: ExecuteOutcome | undefined): Promise<void> {
  if (!row.surface || !row.conversationId || !row.messageRef) {
    log.warn(`${row.id} has no card to update; the decision is recorded but not shown to a human`);
    return;
  }
  const session = deps.surfaces.find(row.surface);
  if (!session) {
    log.warn(`${row.id} was posted on surface "${row.surface}", which this process has not loaded`);
    return;
  }
  const ref: MessageRef = { surface: row.surface, conversation: row.conversationId, id: row.messageRef };
  const outcome = {
    executed: execution?.status === 'executed',
    tool: execution?.status === 'executed' ? execution.tool : undefined,
    error: execution?.status === 'failed' ? execution.error : undefined,
  };
  if (session.capabilities.update) {
    try {
      await session.updateCard(ref, decidedCard(row, outcome));
    } catch (err) {
      log.error(`could not edit the card for ${row.id}`, err);
    }
  }
  try {
    await session.postText(
      row.conversationId,
      threadReplyText(row, (id) => session.mention(id), execution),
      {
        replyTo: ref,
      },
    );
  } catch (err) {
    log.error(`could not post the reply for ${row.id}`, err);
  }
}

/**
 * Record a human decision and, when it is an approval, run the parked action.
 *
 * This function is the only writer of `approvals.status` outside the core tools themselves. The
 * transition is one guarded UPDATE, so two people clicking at once produce one decision and one
 * execution; the loser gets `not_actionable`.
 *
 * A decision may only be taken on the surface the card was posted to. The read below is what
 * tells "answered from the wrong place" apart from "already decided", so the person pressing gets
 * an answer rather than silence; the same predicate is on the UPDATE, so the check is still
 * atomic if the poller claims the row in between.
 */
export async function decideApproval(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult> {
  const now = deps.now();
  const [existing] = await deps.db
    .select({ surface: approvals.surface })
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.client, deps.client)));
  if (existing && existing.surface !== null && existing.surface !== input.surface) {
    return { outcome: 'wrong_surface' };
  }

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
        or(isNull(approvals.surface), eq(approvals.surface, input.surface)),
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

  await tellSurface(deps, row, execution);
  return { outcome: 'decided', status: input.decision, execution };
}
