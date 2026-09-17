import { hashArgs, writeAudit, type RunStatus } from '@harness/core-tools';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import type { RunRequest } from '@harness/runtime-api';
import { describeError } from '@harness/shared';
import type { MessageEvent, MessageRef, StreamHandle, SurfaceSession } from '@harness/surface-api';
import type { Host } from './host.js';
import { openKernel } from './kernel.js';
import { WITHHELD, appendMessage, findOrCreateThread, recentHistory, type ThreadRow } from './threads/repository.js';
import { HISTORY_MAX_CHARS, trimHistory } from './threads/trim.js';

export const UNAUTHORISED_TEXT = 'You are not authorised to use this assistant.';

export interface TurnInput {
  thread: ThreadRow;
  principal: Principal;
  /** `user` for a human's message, `host` for a notice the host writes (an approval outcome). */
  role: 'user' | 'host';
  text: string;
  attachments: readonly { name: string; path: string }[];
  replyTo: MessageRef | null;
}

export interface TurnResult {
  runId: string;
  status: RunStatus;
  text: string;
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
 * One turn of a thread, from the text to the reply (spec 3.2 steps 3–6).
 *
 * Callable from an adapter's `onMessage` today and from an HTTP route in Plan 10: everything it
 * needs is on `host` and `turn`, and nothing it does depends on where the text came from. One
 * kernel per run, one `RunRequest` per run, the events forwarded as they arrive, both turns
 * recorded as `messages` rows, the run closed with the status it ended in. The skill the runtime
 * activates is stamped on the run's own context, which is what `auditBaseFor` reads (decision 6).
 */
export async function runTurn(host: Host, turn: TurnInput): Promise<TurnResult> {
  const surface = host.surfaces.find(turn.thread.surface);
  if (!surface) throw new Error(`thread ${turn.thread.id} is on surface "${turn.thread.surface}", which is not loaded`);
  const kernel = await openKernel(host, {
    principal: turn.principal,
    threadId: turn.thread.id,
    surface: turn.thread.surface,
    conversation: turn.thread.conversation,
  });
  const runId = kernel.context.runId;
  const controller = new AbortController();
  host.active.set(runId, controller);
  const timer = setTimeout(() => controller.abort(), host.budget.timeoutMs);

  await appendMessage(host.db, {
    threadId: turn.thread.id,
    runId,
    role: turn.role,
    principalId: turn.principal.id,
    content: turn.text,
  });
  // Fetch one extra turn beyond the budget: the row just appended above is always the newest,
  // so trimming to `maxHistoryMessages + 1` and dropping the last one always drops that row,
  // leaving exactly `maxHistoryMessages` turns of real history (or fewer, when there is less).
  const history = trimHistory(await recentHistory(host.db, turn.thread.id, host.budget.maxHistoryMessages + 1), {
    maxMessages: host.budget.maxHistoryMessages + 1,
    maxChars: HISTORY_MAX_CHARS,
  }).slice(0, -1);

  const request: RunRequest = {
    runId,
    threadId: turn.thread.id,
    principal: turn.principal,
    input: { text: turn.text, attachments: turn.attachments },
    history,
    persona: host.persona,
    skills: host.skills,
    memory: '',
    tools: kernel.client,
    model: { ...host.model, user: turn.principal.id },
    budget: {
      maxModelCalls: host.budget.maxModelCalls,
      maxToolCalls: host.budget.maxToolCalls,
      timeoutMs: host.budget.timeoutMs,
    },
    signal: controller.signal,
  };

  let status: RunStatus = 'done';
  let text = '';
  let stream: StreamHandle | null = null;
  const recipient = turn.principal.surfaces[turn.thread.surface] ?? '';
  try {
    for await (const event of host.runtime.run(request).events) {
      switch (event.type) {
        case 'text':
          stream ??= replyTarget(surface, turn.thread.conversation, turn.replyTo, recipient);
          stream?.append(event.delta);
          break;
        case 'skill_activated':
          kernel.deps.context.skill = event.name;
          kernel.deps.context.skillVersion = event.version;
          break;
        case 'done':
          text = event.text;
          break;
        case 'error': {
          // A cancel deletes the controller from `active` before it aborts; a timeout does not.
          // That difference is how the same "cancelled" message from the runtime is told apart
          // here: still active means the host's own timeout fired, not `cancelRun`.
          const cancelled = event.message === 'cancelled' && host.active.get(runId) === undefined;
          status = cancelled ? 'cancelled' : 'error';
          text = cancelled ? '' : `The run stopped: ${event.message}.`;
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    host.log.error(`run ${runId} failed while reading the runtime`, err);
    status = 'error';
    text = 'The run stopped: the runtime failed; see the host log.';
  } finally {
    clearTimeout(timer);
    host.active.delete(runId);
  }

  // Invariant 10 on the final post: a reply that trips the check is withheld, not sent.
  const safeText = containsRestrictedPattern(text) ? WITHHELD : text;
  try {
    if (stream) {
      if (safeText === WITHHELD) stream.append(`\n${WITHHELD}`);
      await stream.end();
    } else if (safeText !== '') {
      await surface.postText(turn.thread.conversation, safeText, { replyTo: turn.replyTo ?? undefined });
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
  await kernel.close(status);
  return { runId, status, text: safeText };
}

/**
 * Spec 3.2 steps 1–2, then the turn. A user the identity plug-in does not know is told so, once,
 * and the refusal is the one audit row a message from nobody ever produces (invariant 1). A
 * message that did not address the assistant is ignored (decision 12).
 */
export async function handleMessage(host: Host, event: MessageEvent): Promise<void> {
  if (!event.mentioned) return;
  const surface = host.surfaces.find(event.surface);
  if (!surface) return;
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
  await runTurn(host, {
    thread,
    principal,
    role: 'user',
    text: event.text,
    attachments: event.attachments,
    replyTo: event.message,
  });
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

/** Abort a run in flight. False when no such run is active. Plan 10's run API calls this. */
export function cancelRun(host: Host, runId: string): boolean {
  const controller = host.active.get(runId);
  if (!controller) return false;
  host.active.delete(runId);
  controller.abort();
  return true;
}
