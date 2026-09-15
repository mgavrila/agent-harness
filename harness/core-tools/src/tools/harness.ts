import * as z from 'zod/v4';
import { defineTool, type AnyToolDef } from '../registry.js';
import { reconcile } from '../reconcile.js';

const harnessReconcile = defineTool({
  name: 'harness_reconcile',
  description: 'Expire approvals past their TTL and park dispatches that never completed for human review. Idempotent.',
  actionClass: 'write.internal',
  input: z.object({ stale_after_minutes: z.number().int().min(1).max(1440).default(10) }),
  output: z.object({ approvals_expired: z.number(), dispatches_parked: z.number() }),
  handler: async ({ stale_after_minutes }, deps) => reconcile(deps.db, { now: deps.now, staleAfterMs: stale_after_minutes * 60_000 }),
});

export const harnessTools: AnyToolDef[] = [harnessReconcile];
