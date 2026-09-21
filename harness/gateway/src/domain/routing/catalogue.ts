import * as z from 'zod/v4';

/**
 * One deployment this gateway serves.
 *
 * The other half of a route: a client document names a deployment by name, and this says what
 * that deployment is. Nothing here is per client — two tenants that name the same deployment
 * share it, and a tenant that needs its own gets one registered for it by the platform rather
 * than an entry here.
 */
export const CatalogueEntry = z
  .object({
    /** What a document names this deployment by. Defaults to `model`, which is the usual case. */
    name: z.string().regex(/^\S+$/, 'a deployment name has no spaces in it').optional(),
    /** The upstream model, always provider-prefixed (e.g. `gemini/gemini-3-flash-preview`). */
    model: z.string().regex(/^\S+$/, 'a model is provider-prefixed and has no spaces in it'),
    /** Only for self-hosted endpoints (vLLM, Ollama). A hosted upstream resolves its own base URL. */
    api_base: z.string().url().optional(),
    /** USD per rolling day for this deployment. Falls back to `defaults.daily_budget_usd`. */
    daily_budget_usd: z.number().positive().max(1000).optional(),
    /** Tried in order when this deployment errors or is over budget; each names another entry here. */
    fallbacks: z.array(z.string().min(1)).max(3).default([]),
  })
  // An inline `api_key:` (or any other typo/unsupported field) must fail loudly rather than be
  // silently dropped — the catalogue is not a place to smuggle a literal key past the renderer's
  // os.environ/-only contract.
  .strict();
export type CatalogueEntry = z.infer<typeof CatalogueEntry>;

/** What a document names this deployment by: its own `name`, or the upstream model. */
export function deploymentName(entry: CatalogueEntry): string {
  return entry.name ?? entry.model;
}

export const DeploymentCatalogue = z
  .object({
    deployments: z.array(CatalogueEntry).min(1),
    defaults: z
      .object({
        daily_budget_usd: z.number().positive().max(1000).default(1),
        num_retries: z.number().int().min(0).max(5).default(2),
        request_timeout_s: z.number().int().min(5).max(600).default(120),
      })
      // `.default({})` supplies this object as-is without running it through the inner schema, so
      // an entirely absent `defaults:` key would otherwise skip the per-field defaults above.
      // Spell them out here too.
      .default({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 }),
  })
  .strict()
  .superRefine((catalogue, ctx) => {
    const names = new Set<string>();
    for (const entry of catalogue.deployments) {
      const name = deploymentName(entry);
      if (names.has(name)) {
        ctx.addIssue({ code: 'custom', message: `two deployments are named "${name}"` });
      }
      names.add(name);
    }
    for (const entry of catalogue.deployments) {
      for (const fallback of entry.fallbacks) {
        // A fallback that names nothing is the silent kind of broken: LiteLLM would route to a
        // deployment it does not serve on the day the primary went down.
        if (!names.has(fallback)) {
          ctx.addIssue({
            code: 'custom',
            message: `deployment "${deploymentName(entry)}" falls back to "${fallback}", which no deployment in this catalogue is named`,
          });
        }
      }
    }
  });
export type DeploymentCatalogue = z.infer<typeof DeploymentCatalogue>;
