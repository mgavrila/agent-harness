import * as z from 'zod/v4';
import { SecretRefShape } from './secret-ref.js';

/**
 * The five named routes. Callers ask for a *job* (`extract`, `embed`), never a vendor, so a
 * routing change is a config change. This is the single definition; it lives beside the rest of
 * a client's configuration because `routes` is a section of the client document, and
 * `@harness/gateway` and `@harness/core-tools` both import it from here.
 *
 * `embed` is the odd one: it is an embeddings deployment, not a chat one, so `callModel` refuses
 * it and `embedTexts` in @harness/core-tools calls `POST /v1/embeddings` instead. It is a route
 * like the others here because everything a route *is* to this file — a model, fallbacks, a
 * daily budget, a rendered LiteLLM deployment — is the same for it.
 */
export const ROUTES = ['chat', 'extract', 'reason', 'judge', 'embed'] as const;
export type Route = (typeof ROUTES)[number];

export const RouteSpec = z
  .object({
    /** A LiteLLM model identifier, always upstream-prefixed (e.g. `gemini/gemini-3-flash-preview`). */
    model: z.string().min(1),
    /** Only for self-hosted endpoints (vLLM, Ollama). A hosted upstream resolves its own base URL. */
    api_base: z.string().url().optional(),
    /** Tried in order when the primary deployment errors or is over budget. */
    fallbacks: z.array(z.string().min(1)).max(3).default([]),
    /** USD per rolling day for this route's deployments. */
    daily_budget_usd: z.number().positive().max(1000).optional(),
  })
  // An inline `api_key:` (or any other typo/unsupported field) must fail loudly
  // rather than be silently dropped — a routing file is not a place to smuggle
  // a literal key past the generator's os.environ/-only contract.
  .strict();
export type RouteSpec = z.infer<typeof RouteSpec>;

export const RoutingFile = z
  .object({
    routes: z
      .object({
        chat: RouteSpec,
        extract: RouteSpec,
        reason: RouteSpec,
        judge: RouteSpec,
        embed: RouteSpec,
      })
      .strict(),
    /**
     * This tenant's own gateway key, when it has one.
     *
     * Resolved through the deployment's secret source when the tenant opens and sent as the
     * bearer for that tenant's model calls in place of `LITELLM_MASTER_KEY`. The route names do
     * not change and neither does `model: <route>`: the tenant travels in the key, because a
     * virtual key already carries its own aliases, its own model allow-list and its own budget.
     * Absent, the process key stands, which is what every deployment does today.
     */
    gateway: z.object({ key: SecretRefShape }).strict().optional(),
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
  })
  // Strict, since Plan 11c. An unknown key here used to be stripped, so a mistyped `gatway:`
  // would leave a tenant believing it had its own key while every call went out on the process
  // key — a key falling back in silence, which is the one failure mode a routing file must not
  // have. Only `routes` and `defaults` are written anywhere in this repository and the gateway
  // renderer reads those two, so nothing breaks (spec section 12, constraint 21).
  .strict();
export type RoutingFile = z.infer<typeof RoutingFile>;
