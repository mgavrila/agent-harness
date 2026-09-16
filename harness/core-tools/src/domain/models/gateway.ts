import * as z from 'zod/v4';
import { and, eq } from 'drizzle-orm';
import { modelCalls } from '@harness/db';
import { ModelOutputError, ToolError, requiredEnv } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import {
  ROUTES,
  type GatewayConfig,
  type JsonSchemaSpec,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelGateway,
  type Route,
} from './types.js';

export function gatewayFromEnv(): GatewayConfig {
  const apiKey = requiredEnv('LITELLM_MASTER_KEY');
  // Read directly, not through optionalEnv/numberFromEnv: those treat an empty string as
  // unset, and this function has always treated an empty HARNESS_GATEWAY_URL as the literal
  // empty base URL and an empty numeric variable as `Number('') === 0`, which fails the range
  // check below and throws at startup. Preserving that exact behaviour is the point of leaving
  // these three reads alone — nothing tests it, but nothing should silently change it either.
  // That is also why the layer rule is suppressed here rather than satisfied: the helper it
  // points at cannot express "an empty string is the value". Moving this whole function into
  // app/, where the rule does not apply, is the real fix and is a later task's call.
  /* eslint-disable no-restricted-syntax */
  const raw = process.env.HARNESS_GATEWAY_URL ?? 'http://127.0.0.1:4000';
  const timeout = Number(process.env.HARNESS_GATEWAY_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 600_000) {
    throw new Error('HARNESS_GATEWAY_TIMEOUT_MS must be a number between 1000 and 600000');
  }
  const maxCalls = Number(process.env.HARNESS_GATEWAY_MAX_CALLS_PER_RUN ?? 100);
  /* eslint-enable no-restricted-syntax */
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
 * status and nothing else. Provider error bodies routinely quote the prompt
 * back, and this message reaches `audit_log.error` and the agent.
 */
function gatewayError(route: Route, status: number, body: string): ToolError {
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
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new ToolError(`model route "${opts.route}" timed out after ${config.timeoutMs}ms`);
        }
        throw new ToolError(`model route "${opts.route}" could not reach the gateway at ${config.baseUrl}`);
      }

      if (!response.ok) {
        throw gatewayError(opts.route, response.status, await response.text().catch(() => ''));
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const text = payload.choices?.[0]?.message?.content ?? '';
      const model = payload.model ?? opts.route;
      const inputTokens = payload.usage?.prompt_tokens ?? 0;
      const outputTokens = payload.usage?.completion_tokens ?? 0;
      const costHeader = response.headers.get('x-litellm-response-cost');
      const parsedCost = costHeader === null ? Number.NaN : Number(costHeader);
      const costUsd = Number.isFinite(parsedCost) ? parsedCost : 0;

      return { text, model, inputTokens, outputTokens, costUsd };
    },
  };
}

export async function callModel(deps: ToolDeps, opts: ModelCallOptions): Promise<ModelCallResult> {
  if (!ROUTES.includes(opts.route)) throw new ToolError(`unknown model route "${opts.route}"`);

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

  // Attribution only. LiteLLM's own spend tables are what enforce the budget;
  // this row joins the spend to a run and a route. It is written on the same
  // handle the caller passed, so it rolls back with a failing handler - see
  // "Model calls" in docs/runbook.md.
  await deps.db.insert(modelCalls).values({
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

/** Some providers wrap JSON in a markdown fence even under a response schema. */
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
