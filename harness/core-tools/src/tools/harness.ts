import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { runs } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef } from '../registry.js';
import { reconcile } from '../reconcile.js';

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
    let createRun = false;
    if (nextRunId) {
      const existing = await deps.db.query.runs.findFirst({ where: eq(runs.id, nextRunId) });
      if (existing && existing.client !== deps.client) {
        throw new ToolError(`run ${nextRunId} belongs to another client`);
      }
      createRun = !existing;
    }

    if (run_id !== undefined) deps.context.runId = run_id ?? undefined;
    if (skill !== undefined) deps.context.skill = skill ?? undefined;
    if (skill_version !== undefined) deps.context.skillVersion = skill_version ?? undefined;
    if (nextRunId && createRun) {
      await deps.db.insert(runs).values({ id: nextRunId, client: deps.client, caller: deps.caller });
    }
    return { run_id: deps.context.runId ?? null, skill: deps.context.skill ?? null, skill_version: deps.context.skillVersion ?? null };
  },
});

export const harnessTools: AnyToolDef[] = [harnessSetContext, harnessReconcile];
