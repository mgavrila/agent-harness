import * as z from 'zod/v4';
import { and, eq } from 'drizzle-orm';
import { modelCalls, type Db } from '@harness/db';
import { ModelOutputError, ToolError, requiredEnv, type EnvSource } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import {
  EMBED_ROUTE,
  ROUTES,
  type GatewayConfig,
  type JsonSchemaSpec,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelGateway,
  type Route,
} from './types.js';

/**
 * How this deployment reaches the model gateway, off the environment it is handed.
 *
 * The map is a parameter and never the ambient one, so a process that serves two clients can
 * hand each its own — and so that nothing here reads a global to decide what a run may call.
 */
export function gatewayFromEnv(env: EnvSource): GatewayConfig {
  const apiKey = requiredEnv('LITELLM_MASTER_KEY', '', env);
  // Read off the map directly, not through optionalEnv/numberFromEnv: those treat an empty
  // string as unset, and this function has always treated an empty HARNESS_GATEWAY_URL as the
  // literal empty base URL and an empty numeric variable as `Number('') === 0`, which fails the
  // range check below and throws at startup. Preserving that exact behaviour is the point of
  // leaving these three reads alone — nothing tests it, but nothing should silently change it
  // either.
  const raw = env.HARNESS_GATEWAY_URL ?? 'http://127.0.0.1:4000';
  const timeout = Number(env.HARNESS_GATEWAY_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 600_000) {
    throw new Error('HARNESS_GATEWAY_TIMEOUT_MS must be a number between 1000 and 600000');
  }
  const maxCalls = Number(env.HARNESS_GATEWAY_MAX_CALLS_PER_RUN ?? 100);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 10_000) {
    throw new Error('HARNESS_GATEWAY_MAX_CALLS_PER_RUN must be a whole number between 1 and 10000');
  }
  return { baseUrl: raw.replace(/\/+$/, ''), apiKey, timeoutMs: timeout, maxCallsPerRun: maxCalls };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * A gateway failure reported to the caller carries the route and the HTTP
 * status and nothing else. Model vendor error bodies routinely quote the prompt
 * back, and this message reaches `audit_log.error` and the agent.
 *
 * Shared with `embedTexts`, which reaches the same proxy over the embeddings wire shape: one
 * refusal reads the same sentence whichever route earned it.
 */
export function gatewayError(route: Route, status: number, body: string): ToolError {
  if (/budget/i.test(body)) {
    return new ToolError(`model route "${route}" is over its daily budget; raise it in clients/<name>/routing.yaml`);
  }
  if (status === 401 || status === 403) {
    return new ToolError(
      `model route "${route}" was rejected by the gateway (HTTP ${status}); check LITELLM_MASTER_KEY`,
    );
  }
  return new ToolError(`model route "${route}" failed at the gateway (HTTP ${status})`);
}

/**
 * A request that never got an answer: the configured timeout, or anything else `fetch` raised.
 * Neither message repeats what was sent, for the reason on `gatewayError`.
 */
export function gatewayUnreachable(route: Route, config: GatewayConfig, err: unknown): ToolError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ToolError(`model route "${route}" timed out after ${config.timeoutMs}ms`);
  }
  return new ToolError(`model route "${route}" could not reach the gateway at ${config.baseUrl}`);
}

/** What the proxy charged for one call, off its own header. Zero when it sent nothing readable. */
export function costFromResponse(response: Response): number {
  const header = response.headers.get('x-litellm-response-cost');
  const parsed = header === null ? Number.NaN : Number(header);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The LiteLLM adapter: one chat completion over HTTP, and nothing else. It knows the
 * gateway's wire format and its failure modes; it knows nothing about runs, budgets or the
 * database, which is what `callModel` below adds.
 */
export function httpGateway(config: GatewayConfig): ModelGateway {
  return {
    async call(opts: ModelCallOptions): Promise<ModelCallResult> {
      const body: Record<string, unknown> = {
        model: opts.route,
        messages: opts.messages,
      };
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      if (opts.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema },
        };
      }

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw gatewayUnreachable(opts.route, config, err);
      }

      if (!response.ok) {
        throw gatewayError(opts.route, response.status, await response.text().catch(() => ''));
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const text = payload.choices?.[0]?.message?.content ?? '';
      const model = payload.model ?? opts.route;
      const inputTokens = payload.usage?.prompt_tokens ?? 0;
      const outputTokens = payload.usage?.completion_tokens ?? 0;

      return { text, model, inputTokens, outputTokens, costUsd: costFromResponse(response) };
    },
  };
}

/**
 * One `model_calls` row, from the one place that writes them.
 *
 * Attribution only. LiteLLM's own spend tables are what enforce the budget; this row joins the
 * spend to a run, a client and a route. Three callers: `callModel` below, `embedTexts`, and the
 * host, which records every `usage` event its runtime reports — a spend that used to be counted
 * for the cost cap and then dropped. It is written on the handle the caller passed, so it rolls
 * back with a failing handler — see "Model calls" in docs/runbook.md.
 *
 * A row written here counts against `callModel`'s per-run breaker below, whoever wrote it: a run
 * that has made a hundred model calls has made them whether a tool or the conversation did.
 */
export async function recordModelCall(
  db: Db,
  row: {
    runId: string | null;
    client: string;
    route: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  },
): Promise<void> {
  await db.insert(modelCalls).values(row);
}

export async function callModel(deps: ToolDeps, opts: ModelCallOptions): Promise<ModelCallResult> {
  if (!ROUTES.includes(opts.route)) throw new ToolError(`unknown model route "${opts.route}"`);
  if (opts.route === EMBED_ROUTE) {
    throw new ToolError(`the "${EMBED_ROUTE}" route is an embeddings deployment; call embedTexts, not callModel`);
  }

  // The breaker only binds when there is a run to count against. A call with no
  // run id is a one-off (the eval judge, a manual probe) and is left to the
  // gateway's daily budget.
  const runId = deps.context.runId;
  if (runId) {
    const spent = await deps.db.$count(
      modelCalls,
      and(eq(modelCalls.runId, runId), eq(modelCalls.client, deps.client)),
    );
    if (spent >= deps.gateway.maxCallsPerRun) {
      throw new ToolError(
        `run has already made ${spent} model calls, which is its limit; stop and report rather than retrying`,
      );
    }
  }

  const result = await httpGateway(deps.gateway).call(opts);

  await recordModelCall(deps.db, {
    runId: deps.context.runId ?? null,
    client: deps.client,
    route: opts.route,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });

  return result;
}

/** Some model vendors wrap JSON in a markdown fence even under a response schema. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

export async function callModelJson<T>(
  deps: ToolDeps,
  opts: ModelCallOptions & { jsonSchema: JsonSchemaSpec; validate: z.ZodType<T> },
): Promise<ModelCallResult & { json: T }> {
  const result = await callModel(deps, opts);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(result.text));
  } catch {
    throw new ModelOutputError(opts.route, 'not valid JSON');
  }

  const validated = opts.validate.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ModelOutputError(opts.route, detail);
  }

  return { ...result, json: validated.data };
}
