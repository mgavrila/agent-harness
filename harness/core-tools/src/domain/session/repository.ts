import { eq } from 'drizzle-orm';
import { runs } from '@harness/db';
import { ToolError } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import { reconcile, type ReconcileResult } from '../tooling/reconcile.js';
import { stageEffect } from '../effects/outbox.js';
import { assertNoRestrictedPattern } from '../../shared/redaction/patterns.js';

interface SetContextArgs {
  run_id?: string | null;
  skill?: string | null;
  skill_version?: string | null;
}

interface SetContextResult {
  run_id: string | null;
  skill: string | null;
  skill_version: string | null;
}

interface NotifyArgs {
  text: string;
  idempotency_key: string;
  channel?: string;
  surface?: string;
}

/**
 * `harness_set_context`: adopt a run, skill and version for this session and
 * create the run row if it does not exist yet. An omitted field leaves the
 * context as it was; an explicit null clears it.
 */
export async function setRunContext(deps: ToolDeps, args: SetContextArgs): Promise<SetContextResult> {
  const { run_id, skill, skill_version } = args;
  // Validate before touching the shared context: a run id naming another
  // client's run must not be adopted, and must not leave this session
  // stamping that client's run onto its audit rows.
  const nextRunId = run_id !== undefined ? (run_id ?? undefined) : deps.context.runId;
  let runToCreate: string | undefined;
  if (nextRunId) {
    const existing = await deps.db.query.runs.findFirst({ where: eq(runs.id, nextRunId) });
    if (existing && existing.client !== deps.client) {
      throw new ToolError(`run ${nextRunId} belongs to another client`);
    }
    if (!existing) runToCreate = nextRunId;
  }

  // An omitted field leaves the context as it was; an explicit null clears it.
  if (run_id !== undefined) deps.context.runId = run_id ?? undefined;
  if (skill !== undefined) deps.context.skill = skill ?? undefined;
  if (skill_version !== undefined) deps.context.skillVersion = skill_version ?? undefined;
  if (runToCreate) {
    await deps.db.insert(runs).values({ id: runToCreate, client: deps.client, caller: deps.principal.id });
  }
  return {
    run_id: deps.context.runId ?? null,
    skill: deps.context.skill ?? null,
    skill_version: deps.context.skillVersion ?? null,
  };
}

/**
 * `harness_reconcile`, scoped to the calling client: an agent repairs only its
 * own tenant's rows. Process startup runs `reconcile` unscoped instead, as an
 * operator-level task.
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
