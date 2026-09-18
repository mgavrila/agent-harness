import { ROUTES, type Route } from '@harness/gateway/routing';

export { ROUTES, type Route };

/**
 * The one route that is an embeddings deployment rather than a chat one. `callModel` refuses it
 * — it would post a `messages` array to an endpoint that takes `input` — and `embedTexts` in
 * `domain/knowledge/embed.ts` is its only caller.
 */
export const EMBED_ROUTE: Route = 'embed';

export interface GatewayConfig {
  /** Origin of the LiteLLM proxy, no trailing slash. */
  baseUrl: string;
  /** The proxy master key. A model vendor's own keys never leave the proxy. */
  apiKey: string;
  timeoutMs: number;
  /**
   * The runaway breaker from spec section 4.2. LiteLLM's `max_budget` is a
   * daily cap across everything; this is the per-run one. A loop that calls the
   * extract route a thousand times stays inside the daily budget right up until
   * it does not, and by then the day is gone.
   */
  maxCallsPerRun: number;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  /** A schema name the model vendor echoes back. Lowercase, underscores. */
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelCallOptions {
  route: Route;
  messages: ModelMessage[];
  jsonSchema?: JsonSchemaSpec;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelCallResult {
  text: string;
  /** The model the gateway actually used, which may be a fallback. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * One chat completion, and nothing else.
 *
 * The seam exists so that "talk to a model" is a named interface rather than a `fetch` buried
 * in a helper: `httpGateway(config)` is the LiteLLM adapter, and `startFakeGateway` in
 * `@harness/runtime-api/testing` is the test double — an actual loopback HTTP server, which
 * exercises the header, the usage block and the cost header that a hand-written stub would skip.
 *
 * Budget accounting and the per-run breaker are deliberately NOT here: they need `ToolDeps`
 * and the database, so they live in `callModel`, which wraps this.
 */
export interface ModelGateway {
  call(opts: ModelCallOptions): Promise<ModelCallResult>;
}
