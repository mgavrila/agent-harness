import * as z from 'zod/v4';
import { ACTION_CLASSES, BEHAVIORS } from '@harness/pack-api';
import { LEVELS } from '@harness/shared';

const OverridesShape = z.partialRecord(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS));

/** The action-class table a client overrides, exactly as `policy.yaml` held it. */
export const PolicyFileShape = z.object({
  classes: OverridesShape.optional(),
  levels: z.partialRecord(z.enum(LEVELS), OverridesShape).optional(),
});

/**
 * A client's whole policy section: the override table, plus the tools this client withholds.
 *
 * `tools.hide` names kernel or pack tools this client does not publish (spec decision 7). It
 * withholds a tool **without** blinding the action class it belongs to, which is the difference
 * from setting that class to `blocked`: everything else in the class still works. A name that no
 * loaded pack or kernel catalogue publishes is not an error — a client that lists a tool it never
 * had is simply a client that does not have it — so the list is validated for shape alone.
 */
export const ClientPolicyShape = PolicyFileShape.extend({
  tools: z
    .object({ hide: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]) })
    .strict()
    .default({ hide: [] }),
});
