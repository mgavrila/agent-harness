/**
 * The two `deadlines_*` wrappers, published under the kernel's own names.
 *
 * Both are in `HEALTHCARE_REPLACES`, so the kernel's generic pair is gone from the catalogue for
 * the whole process once this pack loads. Each pins `record_kind: 'provider'` on the kernel call
 * for that reason: a second loaded pack's records must not be recomputed here, nor listed under
 * `provider_name`. The pin is on the kernel call only — the inputs below are unchanged.
 *
 * Every schema here is the object the pre-Plan-5 `tools/deadlines.ts` declared, copied without an
 * edit, down to the order of its members: `docs/architecture/tool-surface.json` records the
 * resolved JSON Schema an MCP client receives, and it has to be the same bytes.
 */
import * as z from 'zod/v4';
import {
  definePackTool,
  type AnyToolDef,
  type DeadlinesComputeResult,
  type DeadlinesUpcomingResult,
} from '@harness/pack-api';
import { URGENCY_BUCKETS } from '../shapes.js';
import { callKernel } from './kernel-call.js';

const deadlinesCompute = definePackTool({
  name: 'deadlines_compute',
  description:
    'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
  actionClass: 'write.internal',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    deadlines: z.array(z.object({ credential_id: z.string(), kind: z.string(), due_at: z.string() })),
  }),
  handler: async ({ provider_id }, deps) => {
    const r = await callKernel<DeadlinesComputeResult>(deps, 'deadlines_compute', {
      record_id: provider_id,
      record_kind: 'provider',
    });
    return {
      deadlines: r.deadlines.map((d) => ({ credential_id: d.attachment_id, kind: d.kind, due_at: d.due_at })),
    };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const deadlinesUpcoming = definePackTool({
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
     * Fingerprint of this exact set of (credential, deadline kind, bucket) triples, independent
     * of item order. A playbook passes this straight through as `harness_notify`'s idempotency
     * key: the same set of items in the same buckets produces the same key, so a re-run digest
     * is a no-op, and an item moving to a tighter bucket changes the key so the next run speaks
     * again. `expirations:none` when there are no items.
     */
    digest_key: z.string(),
  }),
  handler: async (args, deps) => {
    const r = await callKernel<DeadlinesUpcomingResult>(deps, 'deadlines_upcoming', {
      within_days: args.window_days,
      today: args.today,
      limit: args.limit,
      record_kind: 'provider',
    });
    return {
      items: r.items.map((i) => ({
        provider_id: i.record_id,
        provider_name: i.record_name,
        credential_id: i.attachment_id,
        credential_kind: i.attachment_kind,
        kind: i.kind,
        due_at: i.due_at,
        days_left: i.days_left,
        overdue: i.overdue,
        bucket: i.bucket as (typeof URGENCY_BUCKETS)[number],
      })),
      digest_key: r.digest_key,
    };
  },
});

export const deadlineAliases: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
