import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { runs } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef } from '../registry.js';
import { reconcile } from '../reconcile.js';
import { stageEffect } from '../effects.js';

const harnessReconcile = defineTool({
  name: 'harness_reconcile',
  description: 'Expire approvals past their TTL and park dispatches that never completed for human review. Idempotent.',
  actionClass: 'write.internal',
  input: z.object({ stale_after_minutes: z.number().int().min(1).max(1440).default(10) }),
  output: z.object({ approvals_expired: z.number(), dispatches_parked: z.number() }),
  // Scoped to the calling client: an agent repairs only its own tenant's rows.
  // Process startup runs reconcile unscoped, as an operator-level task.
  handler: async ({ stale_after_minutes }, deps) =>
    reconcile(deps.db, { now: deps.now, staleAfterMs: stale_after_minutes * 60_000, client: deps.client }),
});

const harnessSetContext = defineTool({
  name: 'harness_set_context',
  description:
    'Set the run id, skill, and skill version recorded on every later audit row in this session. Pass null to clear a field. ' +
    'Call it when a skill starts. Creates the run row if it does not exist.',
  actionClass: 'write.internal',
  input: z.object({
    run_id: z.string().uuid().nullable().optional(),
    skill: z.string().min(1).nullable().optional(),
    skill_version: z.string().min(1).nullable().optional(),
  }),
  output: z.object({ run_id: z.string().nullable(), skill: z.string().nullable(), skill_version: z.string().nullable() }),
  handler: async ({ run_id, skill, skill_version }, deps) => {
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
      await deps.db.insert(runs).values({ id: runToCreate, client: deps.client, caller: deps.caller });
    }
    return { run_id: deps.context.runId ?? null, skill: deps.context.skill ?? null, skill_version: deps.context.skillVersion ?? null };
  },
});

/**
 * Shapes a restricted identifier takes in free text. The approvals app applies
 * the same check to a Slack card; this one stops a message at the source, so a
 * bad digest never reaches the outbox at all.
 */
const RESTRICTED_TEXT_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number
  /\b\d{2}-\d{7}\b/, // employer identification number
  /\b[A-Za-z]{2}\d{7}\b/, // DEA registration
];

const harnessNotify = defineTool({
  name: 'harness_notify',
  description:
    'Stage one Slack message in this client channel, sent by the dispatcher after the call commits. ' +
    'Use it from a scheduled playbook so the message is audited and sent exactly once per idempotency key: ' +
    'staging the same key twice is a no-op. Refuses text that looks like it carries a restricted identifier.',
  actionClass: 'write.internal',
  input: z.object({
    text: z.string().min(1).max(3000),
    /** Scoped to the client by stageEffect. Make it identify the content, e.g. `expirations:2026-09-15:overdue`. */
    idempotency_key: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,199}$/, 'idempotency_key must be a lowercase slug'),
    channel: z.string().regex(/^[CGD][A-Z0-9]{2,}$/, 'channel must be a Slack channel id').optional(),
  }),
  output: z.object({ effect_id: z.string(), staged: z.boolean() }),
  handler: async ({ text, idempotency_key, channel }, deps) => {
    if (RESTRICTED_TEXT_PATTERNS.some((re) => re.test(text))) {
      throw new ToolError('message refused: it looks like it contains a restricted identifier; restricted values never go to Slack');
    }
    // The text is the payload and is stored encrypted. The summary is a label
    // only: tool_effects.summary is plaintext and operators read it freely.
    return stageEffect(deps, {
      sink: 'slack_message',
      idempotencyKey: idempotency_key,
      payload: { text, channel: channel ?? null },
      summary: `Slack message (${text.length} characters)`,
    });
  },
});

export const harnessTools: AnyToolDef[] = [harnessSetContext, harnessReconcile, harnessNotify];
