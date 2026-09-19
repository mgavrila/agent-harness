import { and, eq } from 'drizzle-orm';
import { runs, type Db } from '@harness/db';
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

/**
 * Close a run: the status it ended in and when. The one writer of `runs.status` after `openRun`.
 *
 * Scoped to the client, even though a run id is a uuid and cannot collide, because a pooled host
 * closes runs for several tenants from one process and a predicate that is only *probably* enough
 * is not a predicate (spec invariant 13). A run id from another tenant matches nothing and the
 * call is a no-op, which is what a caller that has been handed the wrong id should get.
 */
export async function closeRun(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db
    .update(runs)
    .set({ status, endedAt: now() })
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
