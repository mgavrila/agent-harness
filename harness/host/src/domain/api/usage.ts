import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { usageRuns, type Db } from '@harness/db';

/** The widest window one request may ask for: a year and a leap day. */
export const USAGE_MAX_DAYS = 366;

/** How far back a request that names no window reaches. */
export const USAGE_DEFAULT_DAYS = 30;

/**
 * The UTC midnight that starts `at`'s day.
 *
 * The view buckets with `date_trunc('day', ...)`, so every row's `day` is a UTC midnight and a
 * window bound that is anything else compares a whole day against an instant inside it. A window
 * of whole days is the only shape this export has ever had.
 */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The UTC midnight that ends `at`'s day, and `at` itself when it is already one.
 *
 * The upper bound rounds **up** where the lower bound rounds down, and for the same reason: the
 * comparison is `lt` against a column of midnights, so a bound inside a day excludes that whole
 * day. Rounding down would drop today from every request that named no `to` — the bound is `now`
 * — which is the day a caller asking about usage most wants. Identity at an exact midnight, so a
 * caller who named a day boundary still gets a half-open window ending where they said.
 */
export function endOfUtcDay(at: Date): Date {
  const start = startOfUtcDay(at);
  return start.getTime() === at.getTime() ? start : new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * One tenant's usage for one principal on one day.
 *
 * Snake case, because this is what goes on the wire and what a billing system reads; every other
 * shape in the run API is the same. The field names are the view's column names exactly, so a
 * column added to `usage_runs` without a thought fails the test that asserts this list.
 */
export interface UsageRow {
  client: string;
  principal_id: string;
  /** The UTC day this row totals, as `YYYY-MM-DD`. A bucket is a day, not an instant. */
  day: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_seconds: number;
  runs_done: number;
  runs_error: number;
  runs_cancelled: number;
  runs_running: number;
  approvals_requested: number;
  approvals_decided: number;
  sandbox_seconds: number;
}

/**
 * Read `usage_runs` for one tenant over one window.
 *
 * Counts, tokens, cost and seconds, and nothing anybody wrote (invariant 16). The view is where
 * that guarantee lives — it selects no text column at all — and this adds only the tenant
 * predicate and the window, half-open so two adjacent months do not both claim their boundary.
 * The caller passes UTC day boundaries (`startOfUtcDay`), because that is what a `day` column is.
 */
export async function readUsage(db: Db, opts: { client: string; from: Date; to: Date }): Promise<UsageRow[]> {
  const rows = await db
    .select()
    .from(usageRuns)
    .where(and(eq(usageRuns.client, opts.client), gte(usageRuns.day, opts.from), lt(usageRuns.day, opts.to)))
    .orderBy(asc(usageRuns.day), asc(usageRuns.principalId));
  return rows.map((row) => ({
    client: row.client,
    principal_id: row.principalId,
    day: row.day.toISOString().slice(0, 10),
    runs: row.runs,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd,
    duration_seconds: row.durationSeconds,
    runs_done: row.runsDone,
    runs_error: row.runsError,
    runs_cancelled: row.runsCancelled,
    runs_running: row.runsRunning,
    approvals_requested: row.approvalsRequested,
    approvals_decided: row.approvalsDecided,
    sandbox_seconds: row.sandboxSeconds,
  }));
}
