import { and, eq, sql } from 'drizzle-orm';
import { modelCalls, runs, type Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import type { RunContext, ToolDeps } from '../tooling/types.js';
import { reconcile, type ReconcileResult } from '../tooling/reconcile.js';
import { stageEffect } from '../effects/outbox.js';
import { assertNoRestrictedPattern } from '../../shared/redaction/patterns.js';

interface NotifyArgs {
  text: string;
  idempotency_key: string;
  channel?: string;
  surface?: string;
}

export interface OpenRunInput {
  client: string;
  principal: Principal;
  surface?: string | null;
  conversation?: string | null;
  threadId?: string | null;
  /** Reuse an id: the eval pipeline re-opens its run after `resetDatabase` truncated the row. */
  id?: string;
}

/**
 * Open a run: write the `runs` row and hand back the context every row of the run will carry.
 * The one way a run comes to exist — the stdio server calls it once per process, the eval
 * pipeline once per handle, the host once per turn — and nothing a model sends can.
 */
export async function openRun(db: Db, input: OpenRunInput): Promise<RunContext & { runId: string }> {
  const threadId = input.threadId ?? null;
  const surface = input.surface ?? null;
  const conversation = input.conversation ?? null;
  const [row] = await db
    .insert(runs)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      client: input.client,
      principalId: input.principal.id,
      threadId,
      surface,
      conversation,
    })
    .returning({ id: runs.id });
  return { runId: row.id, threadId, surface, conversation };
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** What a run spent, written onto its row when it closes. Zero for a run that called no model. */
export interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const NOTHING_SPENT: RunTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/**
 * What one run spent, summed from its own `model_calls` rows.
 *
 * Summed from the rows rather than counted in memory, so a turn that crashed after writing a
 * call still reports it and the run row and the call rows can never disagree. `usage_runs` reads
 * `runs` alone for its tokens, so this is the one place a run's totals are computed — the host
 * uses it when a turn ends and the approvals executor when an approved call does. Scoped to the
 * client like every other query of a pooled host (spec invariant 13).
 */
export async function sumRunTotals(db: Db, client: string, runId: string): Promise<RunTotals> {
  const [totals] = await db
    .select({
      inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${modelCalls.costUsd}), 0)::real`,
    })
    .from(modelCalls)
    .where(and(eq(modelCalls.runId, runId), eq(modelCalls.client, client)));
  return totals;
}

/**
 * Close a run: the status it ended in, when, and what it spent. The one writer of `runs.status`
 * after `openRun`.
 *
 * Scoped to the client, even though a run id is a uuid and cannot collide, because a pooled host
 * closes runs for several tenants from one process and a predicate that is only *probably* enough
 * is not a predicate (spec invariant 13). A run id from another tenant matches nothing and the
 * call is a no-op, which is what a caller that has been handed the wrong id should get.
 *
 * `totals` defaults to zero rather than to leaving the columns alone: a run closed without them
 * is a run whose caller knows of no spend, and the usage export reads `runs` for its tokens, so
 * "unset" and "nothing" have to be the same row.
 */
export async function closeRun(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date = () => new Date(),
  totals: RunTotals = NOTHING_SPENT,
): Promise<void> {
  await db
    .update(runs)
    .set({ status, endedAt: now(), ...totals })
    .where(and(eq(runs.id, runId), eq(runs.client, client)));
}

/**
 * `harness_reconcile`, scoped to the calling client: an agent repairs only its
 * own tenant's rows.
 */
export async function reconcileForClient(deps: ToolDeps, staleAfterMinutes: number): Promise<ReconcileResult> {
  return reconcile(deps.db, { now: deps.now, staleAfterMs: staleAfterMinutes * 60_000, client: deps.client });
}

/** `harness_notify`: stage one message for the dispatcher to send after the call commits. */
export async function stageNotification(
  deps: ToolDeps,
  { text, idempotency_key, channel, surface }: NotifyArgs,
): Promise<{ effect_id: string; staged: boolean }> {
  assertNoRestrictedPattern(text, 'message');
  // The addressing arguments too, for the reason on `assertNoRestrictedPattern`: they are
  // stored in plaintext and their schemas admit a restricted-looking value.
  assertNoRestrictedPattern(channel, 'conversation id');
  assertNoRestrictedPattern(surface, 'surface name');
  // The text is the payload and is stored encrypted. The summary is a label
  // only: tool_effects.summary is plaintext and operators read it freely.
  return stageEffect(deps, {
    sink: 'surface_message',
    idempotencyKey: idempotency_key,
    // `conversation` and `surface` are both optional and both null when the caller named
    // neither: the host's sink resolves an unaddressed effect to the primary surface's default
    // conversation, which is what every playbook has always meant by "the client channel".
    payload: { text, conversation: channel ?? null, surface: surface ?? null },
    summary: `Message (${text.length} characters)`,
  });
}
