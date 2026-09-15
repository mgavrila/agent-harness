import * as z from 'zod/v4';
import { parse as parseYaml } from 'yaml';

/**
 * The four named routes from spec section 4.2. Callers ask for a *job*
 * (`extract`), never a provider, so a routing change is a config change.
 * This is the single definition; `@harness/core-tools/src/models.ts` imports it.
 */
export const ROUTES = ['chat', 'extract', 'reason', 'judge'] as const;
export type Route = (typeof ROUTES)[number];

export const RouteSpec = z
  .object({
    /** A LiteLLM model identifier, always provider-prefixed (e.g. `gemini/gemini-3-flash-preview`). */
    model: z.string().min(1),
    /** Only for self-hosted endpoints (vLLM, Ollama). Hosted providers resolve their own base URL. */
    api_base: z.string().url().optional(),
    /** Tried in order when the primary deployment errors or is over budget. */
    fallbacks: z.array(z.string().min(1)).max(3).default([]),
    /** USD per rolling day for this route's deployments. */
    daily_budget_usd: z.number().positive().max(1000).optional(),
  })
  // An inline `api_key:` (or any other typo/unsupported field) must fail loudly
  // rather than be silently dropped — a routing file is not a place to smuggle
  // a literal credential past the generator's os.environ/-only contract.
  .strict();
export type RouteSpec = z.infer<typeof RouteSpec>;

export const RoutingFile = z.object({
  routes: z
    .object({
      chat: RouteSpec,
      extract: RouteSpec,
      reason: RouteSpec,
      judge: RouteSpec,
    })
    .strict(),
  defaults: z
    .object({
      daily_budget_usd: z.number().positive().max(1000).default(1),
      num_retries: z.number().int().min(0).max(5).default(2),
      request_timeout_s: z.number().int().min(5).max(600).default(120),
    })
    // `.default({})` supplies this object as-is without running it through the
    // inner schema, so an entirely absent `defaults:` key would otherwise skip
    // the per-field defaults above. Spell them out here too.
    .default({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 }),
});
export type RoutingFile = z.infer<typeof RoutingFile>;

export function parseRouting(yamlText: string): RoutingFile {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = RoutingFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`routing.yaml is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
