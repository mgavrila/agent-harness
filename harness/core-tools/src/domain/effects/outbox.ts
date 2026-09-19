import { and, asc, eq, sql } from 'drizzle-orm';
import { toolEffects, encrypt, decrypt, withTransaction, type Db } from '@harness/db';
import { createLogger, describeError } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import type {
  DispatchOptions,
  DispatchOutcome,
  DispatchResult,
  SinkHandler,
  SinkRegistry,
  StageEffectInput,
} from './types.js';

const log = createLogger('effects');

/**
 * Stage an external side effect from inside a tool handler. The row commits
 * with the handler's transaction, so a handler that throws leaves no effect
 * behind, and a committed handler always has its effect recorded before
 * anything is sent. The payload is stored encrypted only.
 */
export async function stageEffect(
  deps: ToolDeps,
  input: StageEffectInput,
): Promise<{ effect_id: string; staged: boolean }> {
  // Idempotency keys are caller-supplied and only meaningful within a client;
  // two clients computing the same key (e.g. `export:acme`) must not collide.
  const scopedKey = `${deps.client}:${input.idempotencyKey}`;
  const inserted = await deps.db
    .insert(toolEffects)
    .values({
      client: deps.client,
      tool: deps.context.tool ?? 'unknown',
      sink: input.sink,
      idempotencyKey: scopedKey,
      payloadEncrypted: encrypt(JSON.stringify(input.payload ?? null), deps.encryptionKey),
      summary: input.summary.slice(0, 200),
      runId: deps.context.runId ?? null,
    })
    .onConflictDoNothing({ target: [toolEffects.client, toolEffects.idempotencyKey] })
    .returning({ id: toolEffects.id });
  if (inserted.length > 0) return { effect_id: inserted[0].id, staged: true };
  const existing = await deps.db.query.toolEffects.findFirst({
    where: and(eq(toolEffects.client, deps.client), eq(toolEffects.idempotencyKey, scopedKey)),
  });
  if (!existing) throw new Error('effect row missing after insert');
  return { effect_id: existing.id, staged: false };
}

type EffectRow = typeof toolEffects.$inferSelect;

/**
 * Take ownership of one staged row: FOR UPDATE SKIP LOCKED, then move it to
 * `dispatching` in its own short transaction, so the sink call that follows
 * holds no locks. Returns null when another dispatcher got there first.
 */
async function claimEffect(db: Db, id: string, now: () => Date): Promise<EffectRow | null> {
  return withTransaction(db, async (tx) => {
    const [locked] = await tx
      .select()
      .from(toolEffects)
      .where(and(eq(toolEffects.id, id), eq(toolEffects.status, 'staged')))
      .for('update', { skipLocked: true });
    if (!locked) return null;
    const [row] = await tx
      .update(toolEffects)
      .set({ status: 'dispatching', attempts: sql`${toolEffects.attempts} + 1`, updatedAt: now() })
      .where(eq(toolEffects.id, locked.id))
      .returning();
    return row;
  });
}

/**
 * Write the outcome of a dispatch, but only onto a row still in `dispatching`.
 * Anything else was moved on by reconcile or by an operator while the sink was
 * running, and overwriting it would undo their decision; that is reported as
 * false so the caller can count it conflicted and leave the row alone.
 */
async function finishDispatch(db: Db, id: string, values: Partial<EffectRow>): Promise<boolean> {
  const updated = await db
    .update(toolEffects)
    .set(values)
    .where(and(eq(toolEffects.id, id), eq(toolEffects.status, 'dispatching')))
    .returning({ id: toolEffects.id });
  if (updated.length > 0) return true;
  log.warn(`effect ${id} changed state during dispatch; leaving as-is`);
  return false;
}

/**
 * Decrypt a claimed row's payload, hand it to the sink, and record what
 * happened. Success marks `dispatched`; an error returns the row to `staged`
 * for another attempt, or marks it `failed` once `maxAttempts` is reached.
 */
async function sendClaimedEffect(
  db: Db,
  handler: SinkHandler,
  claimed: EffectRow,
  opts: { key: Buffer; maxAttempts: number; now: () => Date },
): Promise<DispatchOutcome> {
  const { key, maxAttempts, now } = opts;
  try {
    const payload: unknown = JSON.parse(decrypt(claimed.payloadEncrypted, key));
    const sinkResult = await handler(payload, {
      id: claimed.id,
      idempotencyKey: claimed.idempotencyKey,
      tool: claimed.tool,
      client: claimed.client,
      summary: claimed.summary,
      runId: claimed.runId,
      attempts: claimed.attempts,
    });
    const written = await finishDispatch(db, claimed.id, {
      status: 'dispatched',
      dispatchedAt: now(),
      updatedAt: now(),
      lastError: null,
      result: sinkResult ?? null,
    });
    return written ? 'dispatched' : 'conflicted';
  } catch (err) {
    const message = describeError(err);
    const exhausted = claimed.attempts >= maxAttempts;
    const written = await finishDispatch(db, claimed.id, {
      status: exhausted ? 'failed' : 'staged',
      lastError: message.slice(0, 500),
      updatedAt: now(),
    });
    if (!written) return 'conflicted';
    return exhausted ? 'failed' : 'retried';
  }
}

/**
 * Send staged effects, oldest first. The sink runs outside any transaction (it
 * is an external call), between claiming the row and recording the outcome. A
 * sink that is not registered leaves the row `staged` and counts as skipped.
 */
export async function dispatchStagedEffects(
  db: Db,
  sinks: SinkRegistry,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const { key, limit = 50, maxAttempts = 3 } = opts;
  const now = opts.now ?? (() => new Date());
  const result: DispatchResult = { dispatched: 0, failed: 0, retried: 0, skipped: 0, conflicted: 0 };

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
    const claimed = await claimEffect(db, candidate.id, now);
    if (!claimed) continue;
    const outcome = await sendClaimedEffect(db, handler, claimed, { key, maxAttempts, now });
    result[outcome] += 1;
  }
  return result;
}

// The `./effects` subpath serves @harness/approvals both the functions above and the types
// they are written in terms of, so the types are re-exported here rather than asking that
// package to reach a second path into this source tree.
export type { DispatchOptions, DispatchResult, SinkHandler, SinkRegistry, StageEffectInput } from './types.js';
