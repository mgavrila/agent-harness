import * as z from 'zod/v4';
import { SecretRefShape } from './secret-ref.js';

/**
 * The five named routes. Callers ask for a *job* (`extract`, `embed`), never a vendor, so a
 * routing change is a config change. This is the single definition; it lives beside the rest of
 * a client's configuration because `routes` is a section of the client document, and
 * `@harness/core-tools` reads it to learn which deployment serves each job.
 *
 * `embed` is the odd one: it is an embeddings deployment, not a chat one, so `callModel` refuses
 * it and `embedTexts` in @harness/core-tools calls `POST /v1/embeddings` instead. It is a route
 * like the others here because everything a route *is* to this file — the name of one deployment
 * the gateway serves — is the same for it.
 */
export const ROUTES = ['chat', 'extract', 'reason', 'judge', 'embed'] as const;
export type Route = (typeof ROUTES)[number];

export const RouteSpec = z
  .object({
    /**
     * The name of a deployment the gateway serves: on a dedicated host, an entry in
     * `harness/gateway/catalogue.yaml`; on a pooled host, a deployment the platform registered
     * for this tenant (`<clientId>/<vendor>/<model>`). What that deployment is — its upstream
     * model, its endpoint, the key it calls with, its budget, its fallbacks — is the deployment's
     * configuration, never the document's.
     */
    model: z.string().regex(/^\S+$/, 'a model is the name of one deployment, with no spaces in it'),
  })
  // Strict, and a route now names a deployment and nothing else: a document still carrying
  // `fallbacks`, `api_base`, `daily_budget_usd` or an inline `api_key:` is refused at load rather
  // than parsed into a field nothing renders. A document field with no effect is the silent
  // fallback class of bug (constraint 21), and a literal key is the one thing a routing section
  // may never carry.
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
     * not change; the model string on the wire is this document's own, so the tenant travels
     * twice over — in the key, which carries its own model allow-list and its own budget, and in
     * the deployment name the platform registered for it. Absent, the process key stands, which
     * is what every dedicated deployment does.
     */
    gateway: z.object({ key: SecretRefShape }).strict().optional(),
  })
  // Strict, since Plan 11c. An unknown key here used to be stripped, so a mistyped `gatway:`
  // would leave a tenant believing it had its own key while every call went out on the process
  // key — a key falling back in silence, which is the one failure mode a routing file must not
  // have. `defaults` went the same way as the per-route LiteLLM fields: retries, timeouts and
  // budgets are the deployment's configuration (spec section 12, constraint 21).
  .strict();
export type RoutingFile = z.infer<typeof RoutingFile>;
