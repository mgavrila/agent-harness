import * as z from 'zod/v4';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { reconcileForClient, stageNotification } from '../domain/session/repository.js';

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

const harnessNotify = defineTool({
  name: 'harness_notify',
  description:
    'Stage one message in this client conversation, sent by the dispatcher after the call commits. ' +
    'Use it from a scheduled playbook so the message is audited and sent exactly once per idempotency key: ' +
    'staging the same key twice is a no-op. Refuses text that looks like it carries a restricted identifier.',
  actionClass: 'write.internal',
  input: z.object({
    text: z.string().min(1).max(3000),
    /** Scoped to the client by stageEffect. Make it identify the content, e.g. `expirations:2026-09-15:overdue`. */
    idempotency_key: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,199}$/, 'idempotency_key must be a lowercase slug'),
    // Still called `channel`: the skills and playbooks that pass it say channel, and renaming an
    // argument an agent has been told about is a behaviour change. What it means is a
    // conversation on the target surface, and only that surface can say whether the id is real —
    // it checks at dispatch and fails that one effect, visible through harness_reconcile.
    channel: z
      .string()
      .regex(CONVERSATION_ID_PATTERN, 'channel must be a conversation id on the target surface')
      .optional(),
    surface: z
      .string()
      .regex(SURFACE_NAME_PATTERN, 'surface must be the name of a loaded messaging surface')
      .optional(),
  }),
  output: z.object({ effect_id: z.string(), staged: z.boolean() }),
  handler: async (args, deps) => stageNotification(deps, args),
});

export const harnessTools: AnyToolDef[] = [harnessReconcile, harnessNotify];
