import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { URGENCY_BUCKETS } from '../domain/deadlines/compute.js';
import { recomputeDeadlines, upcomingDeadlines } from '../domain/deadlines/repository.js';

const deadlinesCompute = defineTool({
  name: 'deadlines_compute',
  description:
    'Recompute expiration and renewal-start deadlines for a record from its attachments. Deterministic, no model call.',
  actionClass: 'write.internal',
  input: z.object({
    record_id: z.string().uuid(),
    record_kind: z.string().min(1).optional().describe('Refuse the write when the record is not of this kind'),
  }),
  output: z.object({
    deadlines: z.array(z.object({ attachment_id: z.string(), kind: z.string(), due_at: z.string() })),
  }),
  handler: async ({ record_id, record_kind }, deps) => recomputeDeadlines(deps, record_id, record_kind),
  recordIds: ({ record_id }) => [record_id],
});

const deadlinesUpcoming = defineTool({
  name: 'deadlines_upcoming',
  description:
    'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date. ' +
    'At most `limit` rows (default 200).',
  actionClass: 'read',
  input: z.object({
    within_days: z.number().int().min(1).max(730).default(90),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.number().int().min(1).max(1000).default(200),
    record_kind: z.string().min(1).optional().describe('Only records of this kind; omit for every kind'),
  }),
  output: z.object({
    items: z.array(
      z.object({
        record_id: z.string(),
        record_name: z.string(),
        attachment_id: z.string(),
        attachment_kind: z.string(),
        kind: z.string(),
        due_at: z.string(),
        days_left: z.number(),
        overdue: z.boolean(),
        bucket: z.enum([...URGENCY_BUCKETS]),
      }),
    ),
    /**
     * Fingerprint of this exact set of (attachment, deadline kind, bucket) triples, independent
     * of item order. A playbook passes this straight through as `harness_notify`'s idempotency
     * key: the same set of items in the same buckets produces the same key, so a re-run digest
     * is a no-op, and an item moving to a tighter bucket changes the key so the next run speaks
     * again. `expirations:none` when there are no items.
     */
    digest_key: z.string(),
  }),
  handler: async (args, deps) => {
    const { items, digest_key } = await upcomingDeadlines(deps, args);
    // `DeadlineItem.bucket` is a plain string in the contract, because a pack cannot import the
    // kernel's bucket list. Every value came from `bucketFor`, which returns one of them.
    return { items: items.map((i) => ({ ...i, bucket: i.bucket as (typeof URGENCY_BUCKETS)[number] })), digest_key };
  },
});

/**
 * The deadline tool that needs a pack to do anything.
 *
 * `deadlines_compute` reads a record's attachments and schedules against the lead days its
 * attachment kinds declare, all of which a pack supplies: with nothing loaded there is no kind
 * to be handed and no record to be handed one, so the call can only fail — and a tool in the
 * catalogue is a claim to the model that it can be called. The publication gate in
 * `tools/catalog.ts` withholds it on the same condition as `documents_classify` and
 * `documents_extract`.
 *
 * `deadlines_upcoming` is not here. It lists what has already been scheduled and answers an
 * empty list, which is a true answer for a client with no records rather than a failure.
 */
export const PACK_DEADLINE_TOOLS = ['deadlines_compute'] as const;

export const deadlineTools: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
