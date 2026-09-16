import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { URGENCY_BUCKETS } from '../domain/deadlines/compute.js';
import { recomputeDeadlines, upcomingDeadlines } from '../domain/deadlines/repository.js';

const deadlinesCompute = defineTool({
  name: 'deadlines_compute',
  description:
    'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
  actionClass: 'write.internal',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    deadlines: z.array(z.object({ credential_id: z.string(), kind: z.string(), due_at: z.string() })),
  }),
  handler: async ({ provider_id }, deps) => recomputeDeadlines(deps, provider_id),
  recordIds: ({ provider_id }) => [provider_id],
});

const deadlinesUpcoming = defineTool({
  name: 'deadlines_upcoming',
  description:
    'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date. ' +
    'At most `limit` rows (default 200).',
  actionClass: 'read',
  input: z.object({
    window_days: z.number().int().min(1).max(730).default(90),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({
    items: z.array(
      z.object({
        provider_id: z.string(),
        provider_name: z.string(),
        credential_id: z.string(),
        credential_kind: z.string(),
        kind: z.string(),
        due_at: z.string(),
        days_left: z.number(),
        overdue: z.boolean(),
        bucket: z.enum([...URGENCY_BUCKETS]),
      }),
    ),
    /**
     * Fingerprint of this exact set of (credential, deadline kind, bucket)
     * triples, independent of item order. A playbook passes this straight
     * through as `harness_notify`'s idempotency key: the same set of items in
     * the same buckets produces the same key, so a re-run digest is a no-op,
     * and an item moving to a tighter bucket changes the key so the next run
     * speaks again. `expirations:none` when there are no items.
     */
    digest_key: z.string(),
  }),
  handler: async (args, deps) => upcomingDeadlines(deps, args),
});

export const deadlineTools: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
