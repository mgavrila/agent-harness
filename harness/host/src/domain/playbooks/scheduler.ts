import { RUN_FAILED_MESSAGE } from '@harness/runtime-api';
import { describeError } from '@harness/shared';
import { RUNTIME_FAILED, runTurn, serialize, type TurnDelivery, type TurnResult } from '../conversation.js';
import type { Host } from '../host.js';
import { findOrCreateThread } from '../threads/repository.js';
import { stagePlaybookNotice } from './notice.js';
import { preflightPlaybook } from './preflight.js';
import { claimDuePlaybooks, finishPlaybookRun, type ClaimedRun } from './repository.js';

/** Spec 5.6: the scheduler ticks every 30 seconds. A constant, not a variable: nothing a deployment tunes. */
export const SCHEDULER_TICK_MS = 30_000;

/** One retry (spec 5.6): a firing takes at most two turns. */
export const MAX_ATTEMPTS = 2;

/**
 * The outcomes worth a second attempt: the runtime, or the transport under it, broke before or
 * while answering. Not the run's own verdicts — cancelled, timed out, over budget, over the cost
 * cap — which a second attempt would only repeat at the same price.
 */
const RETRYABLE = new Set<string>([RUN_FAILED_MESSAGE, RUNTIME_FAILED]);

/** The host's own message for a turn that threw before the runtime answered. */
const TURN_THREW = 'the turn failed before the runtime answered; see the host log';

/**
 * The host's own message for a firing `serialize` refused because the process had begun draining.
 * Its own sentence rather than `TURN_THREW`: nothing broke, the host was stopping, and the
 * schedule fires the playbook again — which is what an operator reading `playbook_runs.error`, or
 * the notice, needs to be able to tell apart from a turn that crashed.
 */
const HOST_STOPPED = 'the host stopped before the run finished';

export interface TickResult {
  claimed: number;
  done: number;
  failed: number;
  preflightFailed: number;
}

export interface SchedulerStatus {
  lastTickAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  ticking: boolean;
}

export interface SchedulerHandle {
  /** One tick, by hand: what a test drives, and what the interval calls. A tick already in flight is returned rather than doubled. */
  tick(): Promise<TickResult>;
  status(): SchedulerStatus;
  /** Clears the interval at once; resolves once the tick in flight has settled. */
  stop(): Promise<void>;
}

/** A playbook's thread is keyed by its name (decision 16); the id fits `CONVERSATION_ID_PATTERN`. */
export function playbookConversation(name: string): string {
  return `playbook:${name}`;
}

/**
 * One firing, from a claimed row to a closed one (spec 3.3 steps 2–4).
 *
 * Preflight first; a failure records the row, stages the one notice and makes no model call.
 * Then the run: one thread per playbook, `kind: 'playbook'`, as the playbook's own service
 * principal, with the playbook's prompt as a host message, its one skill, its timeout and its
 * cost cap, delivered as the file says. A transport failure is retried once; anything else is
 * the run's own verdict, and a shutdown that refused the turn is not retried at all. The last
 * run id and the attempt count go on the row, and a firing that ends `failed` stages the one
 * notice.
 */
export async function executePlaybook(
  host: Host,
  claimed: ClaimedRun,
): Promise<'done' | 'failed' | 'preflight_failed'> {
  const { playbook, run } = claimed;
  const flight = await preflightPlaybook(host, playbook);
  if (!flight.ok) {
    await finishPlaybookRun(host.db, run.id, {
      status: 'preflight_failed',
      runId: null,
      attempts: 0,
      error: flight.reason,
      endedAt: host.now(),
    });
    await stagePlaybookNotice(host, {
      playbook,
      scheduledAt: run.scheduledAt,
      runId: null,
      threadId: null,
      text: `Playbook "${playbook.name}" scheduled for ${run.scheduledAt.toISOString()} did not run: ${flight.reason}.`,
    });
    host.log.warn(`playbook "${playbook.name}": preflight failed: ${flight.reason}`);
    return 'preflight_failed';
  }

  const thread = await findOrCreateThread(
    host.db,
    {
      client: host.client,
      surface: flight.surface.name,
      conversation: playbookConversation(playbook.name),
      principalId: flight.principal.id,
    },
    'playbook',
  );
  const deliver: TurnDelivery =
    playbook.deliver === 'conversation'
      ? { surface: flight.surface.name, conversation: playbook.conversation ?? flight.surface.defaultConversation }
      : 'none';

  let attempts = 0;
  let lastRunId: string | null = null;
  let lastError: string | null = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    let outcome: TurnResult | undefined;
    try {
      outcome = await serialize(host, thread.id, () =>
        runTurn(host, {
          thread,
          principal: flight.principal,
          role: 'host',
          text: playbook.prompt,
          attachments: [],
          replyTo: null,
          deliver,
          skills: [flight.skill],
          timeoutMs: playbook.timeoutS * 1000,
          costCapUsd: playbook.costCapUsd,
        }),
      );
    } catch (err) {
      host.log.error(`playbook "${playbook.name}" attempt ${attempts} threw`, err);
      lastError = TURN_THREW;
      continue;
    }
    // `serialize` answers `undefined` for a turn whose turn came once the host had begun
    // draining: the process is on its way out, nothing ran, and a second attempt would be
    // refused the same way. Recorded as a failed firing — the schedule fires it again — and
    // never retried, which is the one difference between a shutdown and a transport failure.
    if (outcome === undefined) {
      host.log.info(`playbook "${playbook.name}": the host was draining; the firing was not started`);
      lastError = HOST_STOPPED;
      break;
    }
    const result = outcome;
    lastRunId = result.runId;
    if (result.status === 'done') {
      lastError = null;
      break;
    }
    lastError = result.error ?? RUNTIME_FAILED;
    if (!RETRYABLE.has(lastError)) break;
  }

  const status = lastError === null ? 'done' : 'failed';
  await finishPlaybookRun(host.db, run.id, {
    status,
    runId: lastRunId,
    attempts,
    error: lastError,
    endedAt: host.now(),
  });
  if (status === 'failed') {
    await stagePlaybookNotice(host, {
      playbook,
      scheduledAt: run.scheduledAt,
      runId: lastRunId,
      threadId: thread.id,
      text: `Playbook "${playbook.name}" scheduled for ${run.scheduledAt.toISOString()} failed after ${attempts} attempt(s): ${lastError}. See the host log and the playbook_runs table.`,
    });
  }
  host.log.info(`playbook "${playbook.name}": ${status} after ${attempts} attempt(s)`);
  return status;
}

/**
 * The loop (spec 5.6): claim what is due, run each claimed firing one after the other, oldest
 * first. Shaped like `startRunner`'s loops — one interval, a guard against overlapping itself,
 * every failure logged and kept in `status` rather than thrown — with `tick` on the handle so a
 * test drives it by hand against a frozen clock. A firing whose bookkeeping throws is closed as
 * `failed` on a best-effort basis so no row stays `running` because the tick moved on.
 */
export function startScheduler(host: Host, opts: { tickMs: number }): SchedulerHandle {
  const status: SchedulerStatus = {
    lastTickAt: null,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
    ticking: false,
  };
  let stopped = false;
  let inFlight: Promise<TickResult> | null = null;

  async function runTick(): Promise<TickResult> {
    const result: TickResult = { claimed: 0, done: 0, failed: 0, preflightFailed: 0 };
    const claimed = await claimDuePlaybooks(host.db, { client: host.client, now: host.now() });
    result.claimed = claimed.length;
    for (const entry of claimed) {
      let outcome: 'done' | 'failed' | 'preflight_failed';
      try {
        outcome = await executePlaybook(host, entry);
      } catch (err) {
        host.log.error(`playbook "${entry.playbook.name}": the firing could not be recorded`, err);
        await finishPlaybookRun(host.db, entry.run.id, {
          status: 'failed',
          runId: null,
          attempts: 0,
          error: TURN_THREW,
          endedAt: host.now(),
        }).catch((inner: unknown) =>
          host.log.error(`playbook "${entry.playbook.name}": could not close the firing`, inner),
        );
        outcome = 'failed';
      }
      if (outcome === 'done') result.done += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.preflightFailed += 1;
    }
    return result;
  }

  function tick(): Promise<TickResult> {
    if (inFlight) return inFlight;
    status.ticking = true;
    const at = host.now().toISOString();
    inFlight = runTick()
      .then(
        (result) => {
          status.lastTickAt = at;
          status.lastOkAt = at;
          status.lastError = null;
          return result;
        },
        (err: unknown) => {
          status.lastTickAt = at;
          status.lastError = describeError(err);
          status.lastErrorAt = at;
          // A tick that fails is not a process that failed: the claim is transactional, the row
          // it could not take is still due, and the next tick takes it. Warned once, kept in
          // `status`, never rethrown — an unhandled rejection here would end the interval.
          host.log.error(`scheduler tick failed: ${status.lastError}`);
          return { claimed: 0, done: 0, failed: 0, preflightFailed: 0 };
        },
      )
      .finally(() => {
        inFlight = null;
        status.ticking = false;
      });
    return inFlight;
  }

  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, opts.tickMs);

  return {
    tick,
    status: () => ({ ...status }),
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
