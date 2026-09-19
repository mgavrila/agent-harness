import { sql } from 'drizzle-orm';
import { modelCalls, type Db } from '@harness/db';
import { ConfigError, ToolError } from '@harness/shared';
import { costFromResponse, gatewayError, gatewayUnreachable } from '../models/gateway.js';
import { EMBED_ROUTE } from '../models/types.js';
import type { ToolDeps } from '../tooling/types.js';

/**
 * How many texts go in one request to the embed route.
 *
 * A bound, not a tuning knob: the endpoint takes a list, a whole folder in one request would be
 * a megabyte of body and one failure would lose all of it, and a request per chunk would be a
 * round trip per paragraph. Sixty-four is a page or two of prose per call.
 */
export const EMBED_BATCH = 64;

interface EmbeddingsResponse {
  model?: string;
  data?: { index?: number; embedding?: number[] }[];
  usage?: { prompt_tokens?: number };
}

/**
 * One batch: the OpenAI embeddings wire shape, which LiteLLM's `/v1/embeddings` follows exactly.
 *
 * `dimensions` is sent on every request so a deployment whose model can answer at several widths
 * answers at this one; LiteLLM's `drop_params: true` removes it for a deployment that cannot take
 * it, which is why the *answer* is checked as well as the ask.
 *
 * A `model_calls` row is written for attribution, exactly as `callModel` writes one. The per-run
 * call breaker is deliberately **not** applied: it exists to stop a model looping on a tool, and
 * the number of requests a sync makes is decided by how many files the folder holds, not by
 * anything the model chose. What bounds a sync is the folder and the gateway's daily budget.
 */
async function embedBatch(deps: ToolDeps, texts: readonly string[]): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${deps.gateway.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.gateway.apiKey}` },
      body: JSON.stringify({
        model: EMBED_ROUTE,
        input: texts,
        dimensions: deps.embedDims,
        user: deps.principal.id,
      }),
      signal: AbortSignal.timeout(deps.gateway.timeoutMs),
    });
  } catch (err) {
    throw gatewayUnreachable(EMBED_ROUTE, deps.gateway, err);
  }
  if (!response.ok) throw gatewayError(EMBED_ROUTE, response.status, await response.text().catch(() => ''));

  const payload = (await response.json()) as EmbeddingsResponse;
  const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) {
    throw new ToolError(`model route "${EMBED_ROUTE}" returned ${data.length} vector(s) for ${texts.length} text(s)`);
  }
  const vectors = data.map((row) => row.embedding ?? []);
  for (const vector of vectors) {
    if (vector.length !== deps.embedDims) {
      throw new ToolError(
        `model route "${EMBED_ROUTE}" returned a ${vector.length}-dimension vector; this deployment stores ${deps.embedDims}`,
      );
    }
  }

  await deps.db.insert(modelCalls).values({
    runId: deps.context.runId ?? null,
    client: deps.client,
    route: EMBED_ROUTE,
    model: payload.model ?? EMBED_ROUTE,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    // An embeddings deployment produces no completion tokens; the column stays 0 rather than null
    // so a sum over model_calls needs no special case for this route.
    outputTokens: 0,
    costUsd: costFromResponse(response),
  });

  return vectors;
}

/** Embed every text, in order, in batches of `EMBED_BATCH`. An empty list makes no call. */
export async function embedTexts(deps: ToolDeps, texts: readonly string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let from = 0; from < texts.length; from += EMBED_BATCH) {
    vectors.push(...(await embedBatch(deps, texts.slice(from, from + EMBED_BATCH))));
  }
  return vectors;
}

/**
 * Refuse to start when `HARNESS_EMBED_DIMS` and the column disagree (decision 2).
 *
 * A drizzle migration is static SQL, so the width is fixed when the table is created and a
 * deployment cannot change it in place: every stored vector would have to be re-embedded, and
 * pgvector would refuse the `ALTER` while an HNSW index existed. `atttypmod` on a `vector` column
 * is the declared width, plainly — no offset, unlike `varchar` — which is what this reads.
 */
export async function assertEmbedDims(db: Db, dims: number): Promise<void> {
  const rows = (
    await db.execute(
      sql`SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass('knowledge_chunks') AND attname = 'embedding'`,
    )
  ).rows as { atttypmod: number }[];
  const declared = rows[0]?.atttypmod;
  if (declared === undefined) {
    throw new ConfigError('knowledge_chunks does not exist; run pnpm db:migrate before starting');
  }
  if (declared !== dims) {
    throw new ConfigError(
      `HARNESS_EMBED_DIMS is ${dims} but knowledge_chunks.embedding stores ${declared}-dimension vectors; a deployment cannot change its embedding width in place`,
    );
  }
}
