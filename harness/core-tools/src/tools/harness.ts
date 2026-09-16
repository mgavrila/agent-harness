import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { reconcileForClient, setRunContext, stageNotification } from '../domain/session/repository.js';

const harnessReconcile = defineTool({
  name: 'harness_reconcile',
  description: 'Expire approvals past their TTL and park dispatches that never completed for human review. Idempotent.',
  actionClass: 'write.internal',
  input: z.object({ stale_after_minutes: z.number().int().min(1).max(1440).default(10) }),
  output: z.object({ approvals_expired: z.number(), dispatches_parked: z.number() }),
  // Scoped to the calling client: an agent repairs only its own tenant's rows.
  // Process startup runs reconcile unscoped, as an operator-level task.
  handler: async ({ stale_after_minutes }, deps) => reconcileForClient(deps, stale_after_minutes),
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
  output: z.object({
    run_id: z.string().nullable(),
    skill: z.string().nullable(),
    skill_version: z.string().nullable(),
  }),
  handler: async (args, deps) => setRunContext(deps, args),
});

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
    channel: z
      .string()
      .regex(/^[CGD][A-Z0-9]{2,}$/, 'channel must be a Slack channel id')
      .optional(),
  }),
  output: z.object({ effect_id: z.string(), staged: z.boolean() }),
  handler: async (args, deps) => stageNotification(deps, args),
});

export const harnessTools: AnyToolDef[] = [harnessSetContext, harnessReconcile, harnessNotify];
