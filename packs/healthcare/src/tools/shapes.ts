import * as z from 'zod/v4';

/**
 * The two shapes the alias tools' schemas need that used to come from core-tools.
 *
 * Both are copied character for character out of `domain/records/types.ts` and
 * `domain/deadlines/compute.ts`, because the published JSON Schema has to be the same bytes and
 * a pack may not import either module. They are duplicated on purpose and the surface snapshot
 * is what keeps the copies honest: change one and `pnpm --filter @harness/core-tools test` fails.
 */
export const FieldInput = z.object({
  name: z.string().min(1),
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  restricted: z.boolean().optional(),
  source_doc_id: z.string().uuid().optional(),
  source_page: z.number().int().positive().optional(),
});

export const URGENCY_BUCKETS = ['overdue', 'due_7d', 'due_30d', 'due_60d', 'due_90d'] as const;
