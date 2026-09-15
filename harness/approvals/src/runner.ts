import { and, eq } from 'drizzle-orm';
import { approvals, toolEffects, type Db } from '@harness/db';
import { dispatchStagedEffects, type DispatchResult, type SinkRegistry } from '@harness/core-tools/effects';
import type { SlackApi } from './slack.js';
import type { CoreToolsClient } from './execute.js';
import { postPendingApprovals, type PollResult } from './poller.js';

export interface RunnerDeps {
  db: Db;
  api: SlackApi;
  core: CoreToolsClient;
  sinks: SinkRegistry;
  client: string;
  channel: string;
  encryptionKey: Buffer;
  now: () => Date;
}

export interface RunnerIntervals {
  pollMs: number;
  dispatchMs: number;
  reconcileMs: number;
  staleAfterMinutes: number;
}

/** One loop's own view of its health: cleared on every successful tick, so a
 * transient failure does not latch the whole process unhealthy forever. */
export interface RunnerLoopStatus {
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
}

export interface RunnerStatus {
  lastPollAt: string | null;
  lastDispatchAt: string | null;
  lastReconcileAt: string | null;
  /** The most recent error from any loop, kept for the process's own logs; not
   * cleared on a later success elsewhere, so it is never used to decide health
   * — see `loops` below and `collectHealth`. */
  lastError: string | null;
  loops: { poll: RunnerLoopStatus; dispatch: RunnerLoopStatus; reconcile: RunnerLoopStatus };
}

export function runPollTick(deps: RunnerDeps): Promise<PollResult> {
  return postPendingApprovals({ db: deps.db, api: deps.api, client: deps.client, channel: deps.channel, now: deps.now });
}

export function runDispatchTick(deps: RunnerDeps): Promise<DispatchResult> {
  return dispatchStagedEffects(deps.db, deps.sinks, { key: deps.encryptionKey, now: deps.now });
}

/**
 * Reconciliation goes through the MCP tool rather than the `reconcile` helper,
 * so the repair is scoped to this client and lands in `audit_log` like any
 * other call. The app has no privileged path into the data.
 */
export function runReconcileTick(
  deps: RunnerDeps,
  staleAfterMinutes: number,
): Promise<{ approvals_expired: number; dispatches_parked: number }> {
  return deps.core.reconcile(staleAfterMinutes);
}

export interface RunnerHandle {
  status(): RunnerStatus;
  stop(): Promise<void>;
}

/**
 * Three independent loops. Each tick is guarded so a slow one never overlaps
 * itself, and every failure is logged and swallowed: a Slack outage must not
 * stop the dispatcher from retrying five seconds later.
 */
function emptyLoopStatus(): RunnerLoopStatus {
  return { lastError: null, lastErrorAt: null, lastOkAt: null };
}

export function startRunner(deps: RunnerDeps, intervals: RunnerIntervals): RunnerHandle {
  const status: RunnerStatus = {
    lastPollAt: null,
    lastDispatchAt: null,
    lastReconcileAt: null,
    lastError: null,
    loops: { poll: emptyLoopStatus(), dispatch: emptyLoopStatus(), reconcile: emptyLoopStatus() },
  };
  const timers: NodeJS.Timeout[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  function loop(name: 'poll' | 'dispatch' | 'reconcile', everyMs: number, tick: () => Promise<unknown>): void {
    let running = false;
    const timer = setInterval(() => {
      if (stopped || running) return;
      running = true;
      const work = (async () => {
        const at = deps.now().toISOString();
        try {
          await tick();
          if (name === 'poll') status.lastPollAt = at;
          else if (name === 'dispatch') status.lastDispatchAt = at;
          else status.lastReconcileAt = at;
          // A tick that succeeds clears this loop's own error: one transient
          // failure must never latch `/healthz` unhealthy until a restart.
          status.loops[name].lastError = null;
          status.loops[name].lastOkAt = at;
        } catch (err) {
          const message = `${name}: ${err instanceof Error ? err.message : String(err)}`;
          status.lastError = message;
          status.loops[name].lastError = message;
          status.loops[name].lastErrorAt = at;
          console.error(`approvals: ${message}`);
        } finally {
          running = false;
        }
      })();
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    }, everyMs);
    timers.push(timer);
  }

  loop('poll', intervals.pollMs, () => runPollTick(deps));
  loop('dispatch', intervals.dispatchMs, () => runDispatchTick(deps));
  loop('reconcile', intervals.reconcileMs, () => runReconcileTick(deps, intervals.staleAfterMinutes));

  return {
    status: () => ({
      ...status,
      loops: {
        poll: { ...status.loops.poll },
        dispatch: { ...status.loops.dispatch },
        reconcile: { ...status.loops.reconcile },
      },
    }),
    async stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}

export interface HealthSnapshot {
  ok: boolean;
  client: string;
  now: string;
  runner: RunnerStatus;
  effects: { staged: number; failed: number; needs_review: number };
  approvals: { pending: number };
}

function countEffects(db: Db, client: string, status: string): Promise<number> {
  return db.$count(toolEffects, and(eq(toolEffects.client, client), eq(toolEffects.status, status)));
}

/**
 * What the watchdogs read. `ok` is false when something needs a human: an
 * effect gave up or is parked for review, or a loop's *most recent* tick
 * failed. A loop that failed once and has since recovered clears its own
 * `loops.<name>.lastError`, so a transient failure does not latch this
 * unhealthy until a restart; `runner.lastError` is kept only for logs and is
 * never consulted here. A backlog of `staged` rows is normal between ticks
 * and does not fail health either.
 */
export async function collectHealth(db: Db, client: string, runner: RunnerHandle, now: () => Date): Promise<HealthSnapshot> {
  const [staged, failed, needsReview] = await Promise.all([
    countEffects(db, client, 'staged'),
    countEffects(db, client, 'failed'),
    countEffects(db, client, 'needs_review'),
  ]);
  const pending = await db.$count(approvals, and(eq(approvals.client, client), eq(approvals.status, 'pending')));
  const status = runner.status();
  const aLoopIsFailing = Object.values(status.loops).some((loop) => loop.lastError !== null);
  return {
    ok: failed === 0 && needsReview === 0 && !aLoopIsFailing,
    client,
    now: now().toISOString(),
    runner: status,
    effects: { staged, failed, needs_review: needsReview },
    approvals: { pending },
  };
}
