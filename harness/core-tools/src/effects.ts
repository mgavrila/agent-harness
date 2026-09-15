import { and, asc, eq, sql } from 'drizzle-orm';
import { toolEffects, encrypt, decrypt, withTransaction, type Db } from '@harness/db';
import type { ToolDeps } from './registry.js';

export type SinkHandler = (
  payload: unknown,
  effect: { id: string; idempotencyKey: string; tool: string; client: string },
) => Promise<void>;

export type SinkRegistry = Record<string, SinkHandler>;

export interface StageEffectInput {
  sink: string;
  idempotencyKey: string;
  payload: unknown;
  summary: string;
}

/**
 * Stage an external side effect from inside a tool handler. The row commits
 * with the handler's transaction, so a handler that throws leaves no effect
 * behind, and a committed handler always has its effect recorded before
 * anything is sent. The payload is stored encrypted only.
 */
export async function stageEffect(deps: ToolDeps, e: StageEffectInput): Promise<{ effect_id: string; staged: boolean }> {
  const inserted = await deps.db
    .insert(toolEffects)
    .values({
      client: deps.client,
      tool: deps.context.tool ?? 'unknown',
      sink: e.sink,
      idempotencyKey: e.idempotencyKey,
      payloadEncrypted: encrypt(JSON.stringify(e.payload ?? null), deps.encryptionKey),
      summary: e.summary,
      runId: deps.context.runId ?? null,
    })
    .onConflictDoNothing({ target: toolEffects.idempotencyKey })
    .returning({ id: toolEffects.id });
  if (inserted.length > 0) return { effect_id: inserted[0].id, staged: true };
  const existing = await deps.db.query.toolEffects.findFirst({ where: eq(toolEffects.idempotencyKey, e.idempotencyKey) });
  if (!existing) throw new Error('effect row missing after insert');
  return { effect_id: existing.id, staged: false };
}

export interface DispatchOptions {
  key: Buffer;
  limit?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  retried: number;
  skipped: number;
}

/**
 * Send staged effects. Each row is claimed with FOR UPDATE SKIP LOCKED and
 * moved to `dispatching` in its own short transaction, then the sink runs
 * outside any transaction (it is an external call). Success marks
 * `dispatched`; an error increments `attempts` and returns the row to
 * `staged` until `maxAttempts`, after which it is `failed`. A sink that is
 * not registered leaves the row `staged` and counts as skipped.
 */
export async function dispatchStagedEffects(db: Db, sinks: SinkRegistry, opts: DispatchOptions): Promise<DispatchResult> {
  const limit = opts.limit ?? 50;
  const maxAttempts = opts.maxAttempts ?? 3;
  const now = opts.now ?? (() => new Date());
  const result: DispatchResult = { dispatched: 0, failed: 0, retried: 0, skipped: 0 };

  const candidates = await db
    .select({ id: toolEffects.id, sink: toolEffects.sink })
    .from(toolEffects)
    .where(eq(toolEffects.status, 'staged'))
    .orderBy(asc(toolEffects.createdAt))
    .limit(limit);

  for (const candidate of candidates) {
    const handler = sinks[candidate.sink];
    if (!handler) {
      result.skipped += 1;
      continue;
    }

    const claimed = await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select()
        .from(toolEffects)
        .where(and(eq(toolEffects.id, candidate.id), eq(toolEffects.status, 'staged')))
        .for('update', { skipLocked: true });
      if (!locked) return null;
      const [row] = await tx
        .update(toolEffects)
        .set({ status: 'dispatching', attempts: sql`${toolEffects.attempts} + 1`, updatedAt: now() })
        .where(eq(toolEffects.id, locked.id))
        .returning();
      return row;
    });
    if (!claimed) continue;

    try {
      const payload: unknown = JSON.parse(decrypt(claimed.payloadEncrypted, opts.key));
      await handler(payload, { id: claimed.id, idempotencyKey: claimed.idempotencyKey, tool: claimed.tool, client: claimed.client });
      await db
        .update(toolEffects)
        .set({ status: 'dispatched', dispatchedAt: now(), updatedAt: now(), lastError: null })
        .where(eq(toolEffects.id, claimed.id));
      result.dispatched += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = claimed.attempts >= maxAttempts;
      await db
        .update(toolEffects)
        .set({ status: exhausted ? 'failed' : 'staged', lastError: message, updatedAt: now() })
        .where(eq(toolEffects.id, claimed.id));
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
