/**
 * Sends one staged effect. The second argument carries the row's context so a
 * sink can key its own idempotency, label the message, or back off on a retry.
 *
 * Anything returned is stored on the row in plaintext jsonb (`tool_effects.result`)
 * for operators to trace the effect to what it produced, so a sink must return
 * only non-restricted values — identifiers and timestamps, never payload
 * content. Return nothing when there is nothing to record.
 */
export type SinkHandler = (
  payload: unknown,
  effect: {
    id: string;
    idempotencyKey: string;
    tool: string;
    client: string;
    summary: string;
    runId: string | null;
    attempts: number;
  },
) => Promise<Record<string, unknown> | void>;

export type SinkRegistry = Record<string, SinkHandler>;

export interface StageEffectInput {
  sink: string;
  idempotencyKey: string;
  payload: unknown;
  /** A short human label. Never put restricted values here; it is stored in plaintext. */
  summary: string;
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
  /** Rows that left `dispatching` while the sink was running, so the dispatcher did not write their outcome. */
  conflicted: number;
}

/** Which counter a single row's dispatch attempt lands in. */
export type DispatchOutcome = 'dispatched' | 'failed' | 'retried' | 'conflicted';
