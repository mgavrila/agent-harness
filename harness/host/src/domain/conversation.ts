import { hashArgs, memorySnapshot, writeAudit, type RunStatus } from '@harness/core-tools';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import type { RunRequest, RunSkill } from '@harness/runtime-api';
import { describeError } from '@harness/shared';
import type { MessageEvent, MessageRef, StreamHandle, SurfaceSession } from '@harness/surface-api';
import type { Host } from './host.js';
import { openKernel } from './kernel.js';
import { WITHHELD, appendMessage, findOrCreateThread, recentHistory, type ThreadRow } from './threads/repository.js';
import { HISTORY_MAX_CHARS, trimHistory } from './threads/trim.js';

export const UNAUTHORISED_TEXT = 'You are not authorised to use this assistant.';

/**
 * The production value of `budget.timeoutMarginMs`: how long after the run's own budget the host's
 * abort fires. A runtime arms its timeout on `budget.timeoutMs` exactly, so without a margin the
 * two timers race and the human reads whichever won — this host's `TIMED_OUT`, which knows only
 * that the budget was spent, or the runtime's own account of what it was doing when it ran out.
 * The margin makes the runtime's the one that wins and leaves this timer as the backstop for a
 * runtime that never returns at all.
 */
export const TIMEOUT_MARGIN_MS = 5_000;

/** How long `app/main.ts` gives the turns in flight to unwind before it stops the runtime. */
export const SHUTDOWN_DRAIN_MS = 10_000;

const ABORT_REASONS = ['cancelled', 'timeout', 'cost-cap'] as const;

/**
 * Why a run's controller was aborted. `cancelRun` (and the shutdown drain through it) says
 * `cancelled`; the host's backstop timer says `timeout`; the cost cap says `cost-cap`. The
 * runtime reports every abort as `cancelled`, so this is how `runTurn` tells them apart.
 */
export type AbortReason = (typeof ABORT_REASONS)[number];

/**
 * The reason on a signal, when the host itself put one there. Null for a signal that is not
 * aborted and for any reason the host did not write — `AbortController.abort()` with no argument
 * leaves a `DOMException` — so an unrecognised abort takes the conservative path rather than being
 * asserted into a reason it never had.
 */
function abortReasonOf(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) return null;
  const reason: unknown = signal.reason;
  return ABORT_REASONS.find((known) => known === reason) ?? null;
}

/** The host's own failure messages, in the same fixed-string register as the runtime's. */
export const RUNTIME_FAILED = 'the runtime failed; see the host log';
export const COST_CAP_EXCEEDED = 'the run exceeded its cost cap';
export const TIMED_OUT = 'the run exceeded its time budget';

/**
 * What the host's own aborts mean once the runtime has finished, whatever it finished with. A
 * `cancelled` abort is absent on purpose: a cancel ends the run `cancelled`, not `error`, and a
 * runtime that ignores one has simply answered a question nobody is waiting for any more.
 */
const FORCED_OUTCOME: Partial<Record<AbortReason, string>> = {
  timeout: TIMED_OUT,
  'cost-cap': COST_CAP_EXCEEDED,
};

/**
 * Where a turn's reply goes. `'thread'`: the thread's own conversation, streamed when the surface
 * can — a chat turn, a resume. `'none'`: recorded on the thread and posted nowhere — a playbook
 * under `deliver: none`. A target: posted once to that conversation, never streamed — a playbook
 * under `deliver: conversation`.
 */
export type TurnDelivery = 'thread' | 'none' | { surface: string; conversation: string };

export interface TurnInput {
  thread: ThreadRow;
  principal: Principal;
  /** `user` for a human's message, `host` for a notice the host writes (an approval outcome, a playbook's prompt). */
  role: 'user' | 'host';
  text: string;
  attachments: readonly { name: string; path: string }[];
  replyTo: MessageRef | null;
  /** Default `'thread'`. */
  deliver?: TurnDelivery;
  /** The skills offered to the runtime. Default: every loaded skill. A playbook passes its one skill. */
  skills?: readonly RunSkill[];
  /** This turn's budget timeout in place of the host's; the backstop timer follows it. */
  timeoutMs?: number;
  /** Abort once the runtime's reported spend passes this. Undefined: no cap beyond the call ceilings. */
  costCapUsd?: number;
}

export interface TurnResult {
  runId: string;
  status: RunStatus;
  text: string;
  /** Why the run did not end `done`: the runtime's fixed message, `'cancelled'`, or the host's own. Null when it did. */
  error: string | null;
}

interface DeliveryTarget {
  session: SurfaceSession;
  conversation: string;
  /** Only the thread's own conversation is streamed; an explicit target is one post at the end. */
  stream: boolean;
}

/** Resolve `deliver` to a surface and a conversation, or null for `'none'`. A surface that is not loaded is an error before any run opens. */
function deliveryTarget(
  host: Host,
  threadSurface: SurfaceSession,
  thread: ThreadRow,
  delivery: TurnDelivery,
): DeliveryTarget | null {
  if (delivery === 'none') return null;
  if (delivery === 'thread') return { session: threadSurface, conversation: thread.conversation, stream: true };
  const session = host.surfaces.find(delivery.surface);
  if (!session)
    throw new Error(`turn on thread ${thread.id} delivers to surface "${delivery.surface}", which is not loaded`);
  return { session, conversation: delivery.conversation, stream: false };
}

/** Where the reply goes: a stream when the surface has one, else one post at the end. */
function replyTarget(
  surface: SurfaceSession,
  conversation: string,
  replyTo: MessageRef | null,
  recipient: string,
): StreamHandle | null {
  if (!surface.capabilities.streaming) return null;
  return surface.startStream(conversation, { replyTo: replyTo ?? undefined, recipient });
}

/**
 * One turn of a thread, from the text to the reply (spec 3.2 steps 3–6; spec 3.3 step 3 for a
 * playbook).
 *
 * Callable from an adapter's `onMessage` today, from the scheduler, and from an HTTP route in
 * Plan 10: everything it needs is on `host` and `turn`, and nothing it does depends on where the
 * text came from. One kernel per run, one `RunRequest` per run — with the caller's memory
 * rendered into it once, before the runtime starts — the events forwarded as they arrive, both
 * turns recorded as `messages` rows, the run closed with the status it ended in. The skill the
 * runtime activates is stamped on the run's own context, which is what `auditBaseFor` reads.
 */
export async function runTurn(host: Host, turn: TurnInput): Promise<TurnResult> {
  const surface = host.surfaces.find(turn.thread.surface);
  if (!surface) throw new Error(`thread ${turn.thread.id} is on surface "${turn.thread.surface}", which is not loaded`);
  const delivery = turn.deliver ?? 'thread';
  const target = deliveryTarget(host, surface, turn.thread, delivery);
  const kernel = await openKernel(host, {
    principal: turn.principal,
    threadId: turn.thread.id,
    surface: turn.thread.surface,
    conversation: turn.thread.conversation,
  });
  const runId = kernel.context.runId;
  const controller = new AbortController();
  const abort = (reason: AbortReason): void => controller.abort(reason);
  // `finished` is what `drainActive` waits on: it resolves in the `finally` below, after the run
  // row and the kernel are closed, so a shutdown that waits for it cannot stop the runtime or end
  // the pool under a turn that is still unwinding.
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  host.active.set(runId, { controller, done: finished });
  const timeoutMs = turn.timeoutMs ?? host.budget.timeoutMs;
  const timer = setTimeout(() => abort('timeout'), timeoutMs + host.budget.timeoutMarginMs);

  // `status` starts as the pessimistic outcome: a throw anywhere below, before the happy path
  // (or the runtime's own error/cancel handling) gets to set it, still has to close the run and
  // the kernel as `error` rather than leaving the row `running` forever. Everything that touches
  // the database, the runtime or the surface from here on is inside the outer `try`, so the
  // `finally` — closing the timer, `active` and the kernel — runs on every path out of this
  // function: success, a caught runtime failure, or an uncaught throw alike. The inner `try`
  // exists only to force `status` to `error` on an uncaught throw even after the happy path had
  // already moved it on to `done` — a failure appending the reply is still a failed run, not a
  // successful one that merely lost its own record.
  let status: RunStatus = 'error';
  let error: string | null = RUNTIME_FAILED;
  let text = '';
  try {
    try {
      await appendMessage(host.db, {
        threadId: turn.thread.id,
        runId,
        role: turn.role,
        principalId: turn.principal.id,
        content: turn.text,
      });
      // The row just appended is always the newest, and it is the turn being run, not history:
      // it is dropped *before* the character budget is spent, so a long message cannot empty its
      // own history. `+ 1` fetches it so that exactly `maxHistoryMessages` real turns remain.
      const rows = await recentHistory(host.db, turn.thread.id, host.budget.maxHistoryMessages + 1);
      const history = trimHistory(rows.slice(0, -1), {
        maxMessages: host.budget.maxHistoryMessages,
        maxChars: HISTORY_MAX_CHARS,
      });
      // Rendered once, here, and never touched again for this run: a fact the model adds during
      // the turn is in the next turn's snapshot, not this one's (spec 5.5, "frozen for this run").
      const memory = await memorySnapshot(host.db, host.client, turn.principal.id);

      const request: RunRequest = {
        runId,
        threadId: turn.thread.id,
        principal: turn.principal,
        input: { text: turn.text, attachments: turn.attachments },
        history,
        persona: host.persona,
        skills: turn.skills ?? host.skills,
        memory,
        tools: kernel.client,
        model: { ...host.model, user: turn.principal.id },
        budget: {
          maxModelCalls: host.budget.maxModelCalls,
          maxToolCalls: host.budget.maxToolCalls,
          timeoutMs,
        },
        signal: controller.signal,
      };

      status = 'done';
      error = null;
      let stream: StreamHandle | null = null;
      let spentUsd = 0;
      const recipient = turn.principal.surfaces[turn.thread.surface] ?? '';
      try {
        for await (const event of host.runtime.run(request).events) {
          switch (event.type) {
            case 'text':
              if (target?.stream) {
                stream ??= replyTarget(target.session, target.conversation, turn.replyTo, recipient);
                stream?.append(event.delta);
              }
              break;
            case 'usage':
              // What the cap bounds today is whatever the runtime reports; see the runbook's
              // "Playbooks" section for what that is worth with the shipped runtime.
              spentUsd += event.costUsd;
              if (turn.costCapUsd !== undefined && spentUsd > turn.costCapUsd && !controller.signal.aborted) {
                abort('cost-cap');
              }
              break;
            case 'skill_activated':
              kernel.deps.context.skill = event.name;
              kernel.deps.context.skillVersion = event.version;
              break;
            case 'done':
              text = event.text;
              break;
            case 'error': {
              // The runtime says `cancelled` for every abort; the controller's reason says whose.
              // Only a cancel is settled here: the host's own aborts are applied below, so that a
              // runtime which never reports the abort cannot get a different outcome from one
              // that does.
              if (event.message === 'cancelled' && abortReasonOf(controller.signal) === 'cancelled') {
                status = 'cancelled';
                error = 'cancelled';
                text = '';
              } else {
                status = 'error';
                error = event.message;
                text = `The run stopped: ${event.message}.`;
              }
              break;
            }
            default:
              break;
          }
        }
      } catch (err) {
        host.log.error(`run ${runId} failed while reading the runtime`, err);
        status = 'error';
        error = RUNTIME_FAILED;
        text = `The run stopped: ${RUNTIME_FAILED}.`;
      }

      // The host's abort is a decision, not a suggestion, and the outcome follows from it rather
      // than from what the runtime did next. A runtime that ignores `request.signal` can still
      // answer, throw, or report the cancel under its own message; none of those may turn a run
      // the host stopped into a `done` one, or bury why it was stopped. The cap in particular
      // would otherwise be enforced only by runtimes that choose to honour it.
      const abortedFor = abortReasonOf(controller.signal);
      const forced = abortedFor === null ? undefined : FORCED_OUTCOME[abortedFor];
      if (forced !== undefined) {
        status = 'error';
        error = forced;
        text = `The run stopped: ${forced}.`;
      }

      // Invariant 10 on the final post: a reply that trips the check is withheld, not sent.
      const safeText = containsRestrictedPattern(text) ? WITHHELD : text;
      try {
        if (stream && target) {
          if (safeText === WITHHELD) stream.append(`\n${WITHHELD}`);
          const streamedRef = await stream.end();
          // The deltas already streamed cannot carry a notice that only shows up once the
          // runtime is done; a stream that ends in error still owes the human that notice, as a
          // reply to what was already sent rather than silence next to the partial answer.
          if (status === 'error') {
            await target.session.postText(target.conversation, safeText, { replyTo: streamedRef });
          }
        } else if (target && safeText !== '') {
          await target.session.postText(target.conversation, safeText, {
            replyTo: delivery === 'thread' ? (turn.replyTo ?? undefined) : undefined,
          });
        }
      } catch (err) {
        host.log.error(`run ${runId}: could not post the reply`, err);
      }
      if (status !== 'cancelled' && text !== '') {
        await appendMessage(host.db, {
          threadId: turn.thread.id,
          runId,
          role: 'assistant',
          principalId: turn.principal.id,
          content: text,
        });
      }
      return { runId, status, text: safeText, error };
    } catch (err) {
      status = 'error';
      error ??= RUNTIME_FAILED;
      throw err;
    }
  } finally {
    clearTimeout(timer);
    host.active.delete(runId);
    try {
      await kernel.close(status);
    } finally {
      finish();
    }
  }
}

/**
 * Run `fn` after every turn already queued on this thread, and never beside one.
 *
 * Two messages from one person a few seconds apart are ordinary; so is a decision resuming a
 * thread that is still mid-turn. Run concurrently they both read the same history, and a runtime
 * that keeps its own per-thread state (a checkpointer, keyed on the thread id) has two turns
 * appending to the same checkpoint, where whichever finishes last silently becomes the thread's
 * state. The chain is per thread, so different conversations still run at the same time.
 *
 * The chain's tail is stored with its failures swallowed — a turn that throws must not stop the
 * next message on that thread — and dropped from the map once it drains, so an idle thread leaves
 * nothing behind.
 *
 * A turn whose turn comes once the host is draining is dropped rather than started: the process is
 * on its way out, and the run it would open is one nothing would be left to close. The human is
 * told nothing, because there is no longer a process to tell them from.
 */
export function serialize<T>(host: Host, threadId: string, fn: () => Promise<T>): Promise<T | undefined> {
  const previous = host.turns.get(threadId) ?? Promise.resolve();
  const result = previous.then(() => {
    if (host.draining) {
      host.log.info(`thread ${threadId}: the host is shutting down; the turn was not started`);
      return undefined;
    }
    return fn();
  });
  const chain = result.then(
    () => undefined,
    () => undefined,
  );
  host.turns.set(threadId, chain);
  void chain.then(() => {
    if (host.turns.get(threadId) === chain) host.turns.delete(threadId);
  });
  return result;
}

/**
 * Cancel every turn in flight and wait for them, for at most `boundMs`, and refuse every turn that
 * has not started yet. What shutdown calls between aborting and stopping anything the turns are
 * still using: each entry's promise resolves
 * only once that turn has closed its run row, so a drained host leaves no run `running` forever.
 * Nothing sweeps such a row afterwards — `harness_reconcile` touches approvals and dispatches, not
 * runs — which is why the bound is a bound and not the absence of one.
 */
export async function drainActive(host: Host, boundMs: number): Promise<void> {
  host.draining = true;
  const inflight = [...host.active.entries()];
  if (inflight.length === 0) return;
  for (const [runId] of inflight) cancelRun(host, runId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
  });
  try {
    const drained = await Promise.race([Promise.all(inflight.map(([, run]) => run.done)).then(() => true), bounded]);
    if (!drained) {
      host.log.warn(`${inflight.length} run(s) had not finished ${boundMs}ms after the abort; stopping anyway`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spec 3.2 steps 1–2, then the turn. A user the identity plug-in does not know is told so, once,
 * and the refusal is the one audit row a message from nobody ever produces (invariant 1). A
 * message that did not address the assistant is ignored (decision 12).
 */
export async function handleMessage(host: Host, event: MessageEvent): Promise<void> {
  if (!event.mentioned) return;
  const surface = host.surfaces.find(event.surface);
  if (!surface) {
    host.log.warn(`message from surface "${event.surface}", which is not loaded`);
    return;
  }
  const principal = await host.identity.resolve({ surface: event.surface, userId: event.userId });
  if (!principal) {
    await writeAudit(host.db, {
      client: host.client,
      caller: `${event.surface}:${event.userId}`,
      tool: 'host_message',
      actionClass: 'read',
      argsHash: hashArgs({ conversation: event.conversation }),
      decision: 'unauthorised',
    });
    try {
      await surface.postText(event.conversation, UNAUTHORISED_TEXT, { replyTo: event.message ?? undefined });
    } catch (err) {
      host.log.error('could not post the unauthorised notice', err);
    }
    return;
  }
  const thread = await findOrCreateThread(host.db, {
    client: host.client,
    surface: event.surface,
    conversation: event.conversation,
    principalId: principal.id,
  });
  await serialize(host, thread.id, () =>
    runTurn(host, {
      thread,
      principal,
      role: 'user',
      text: event.text,
      attachments: event.attachments,
      replyTo: event.message,
    }),
  );
}

/** Register the flow on every loaded surface. A handler's failure is logged, never thrown into the adapter. */
export function attachMessageHandlers(host: Host): void {
  for (const session of host.surfaces.all) {
    session.onMessage(async (event) => {
      try {
        await handleMessage(host, event);
      } catch (err) {
        host.log.error(`the message handler failed on surface "${session.name}": ${describeError(err)}`);
      }
    });
  }
}

/**
 * Abort a run in flight. False when no such run is active, or when its controller was already
 * aborted — by the host's own backstop, say — so a cancel arriving after a timeout cannot claim
 * the run and flip its status. Plan 10's run API calls this.
 */
export function cancelRun(host: Host, runId: string): boolean {
  const run = host.active.get(runId);
  if (!run || run.controller.signal.aborted) return false;
  host.active.delete(runId);
  run.controller.abort('cancelled' satisfies AbortReason);
  return true;
}
