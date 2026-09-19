import { describeError, SurfaceError } from '@harness/shared';
import type { StreamHandle } from '@harness/surface-api';
import { toMrkdwn } from './format.js';
import { guarded, NAME } from './guarded.js';
import type { SlackApi } from './transport/types.js';

/**
 * How often a streamed reply is edited. `chat.update` is a Tier 3 method (about fifty calls a
 * minute per app); one edit every 1.5 s per reply leaves room for several replies at once and
 * for the approvals loops' own calls.
 */
export const STREAM_EDIT_INTERVAL_MS = 1500;

export interface StreamDeps {
  /** A streamed reply is two `chat` calls and nothing else, so that is all this asks for. */
  api: Pick<SlackApi, 'chat'>;
  conversation: string;
  threadTs?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
}

/**
 * A streamed reply as one message edited in place. The first delta posts the message. Every
 * later delta is folded into the next edit: `scheduleEdit` waits for the post to have landed —
 * the only moment it is safe to compute how long is left in the interval — and only then arms
 * the timer, no sooner than the interval after the previous call.
 *
 * `end` sets a flag that both that wait and the timer's own callback check before doing anything
 * further, so a trailing edit still waiting on the post, or already timed and about to fire, is
 * folded into `end`'s own final edit rather than sent a second time; a timer that has already
 * been armed is cleared outright, so nothing keeps the event loop alive past `end`. Every actual
 * edit — a periodic one and the final one — is queued onto `editQueue`, one at a time, so `end`'s
 * final edit always waits for whatever edit is already in flight rather than racing it to the
 * same message. `posting` itself never rejects: a failed first post is recorded in `failed` and
 * surfaced only when something actually needs to know, in `end`, as a `SurfaceError`; that keeps
 * `append`'s fire-and-forget `void post()` from ever becoming an unhandled rejection no matter
 * how long it sits before anything awaits it. A mid-stream edit's failure is swallowed the same
 * way — the text it carried arrives with the next edit or the final one, so failing the whole
 * stream over one rate-limited or transient edit would only drop text nothing else ever resends.
 * A failed final edit still rejects `end` with a `SurfaceError`, so the host logs it once.
 * `append` after `end` is a no-op: the reply already told the world it was done, and nothing
 * reopens it.
 */
export function createEditStream(deps: StreamDeps): StreamHandle {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setTimeout ?? setTimeout;
  let text = '';
  let ts: string | null = null;
  let posting: Promise<void> | null = null;
  let failed: SurfaceError | null = null;
  let lastCall = 0;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  let ended = false;
  let editQueue: Promise<void> = Promise.resolve();

  const post = (): Promise<void> => {
    posting ??= guarded('chat.postMessage', () =>
      deps.api.chat.postMessage({ channel: deps.conversation, text: toMrkdwn(text), thread_ts: deps.threadTs }),
    ).then(
      (res) => {
        ts = res.ts ?? '';
        lastCall = now();
      },
      // Caught here, not left to whoever eventually awaits `posting`: `append` calls `post`
      // fire-and-forget, and a rejection nobody has attached a handler to yet by the time it
      // settles is flagged unhandled by Node even if `end` awaits the same promise moments
      // later. `posting` resolving unconditionally means it never can be.
      (err: unknown) => {
        failed =
          err instanceof SurfaceError
            ? err
            : new SurfaceError(`${NAME}: chat.postMessage failed: ${describeError(err)}`);
      },
    );
    return posting;
  };

  /** Queue one edit onto `editQueue`, so it runs after whatever edit is already in flight. */
  const runEdit = (final: boolean): Promise<void> => {
    editQueue = editQueue.then(async () => {
      if (!ts) return;
      lastCall = now();
      const postedTs = ts;
      const mrkdwn = toMrkdwn(text);
      if (final) {
        await guarded('chat.update', () =>
          deps.api.chat.update({ channel: deps.conversation, ts: postedTs, text: mrkdwn }),
        );
      } else {
        await deps.api.chat.update({ channel: deps.conversation, ts: postedTs, text: mrkdwn }).catch(() => undefined);
      }
    });
    return editQueue;
  };

  const scheduleEdit = (): void => {
    if (pending) return;
    pending = true;
    void (async () => {
      await posting;
      // `end` may have run while this was waiting for the post; its own final edit already
      // covers whatever text had accumulated, so there is nothing left for this cycle to send.
      if (ended) return;
      const wait = Math.max(0, STREAM_EDIT_INTERVAL_MS - (now() - lastCall));
      await new Promise<void>((resolve) => {
        timer = schedule(() => {
          timer = null;
          resolve();
        }, wait);
      });
      pending = false;
      if (ended) return;
      await runEdit(false);
    })().catch(() => undefined);
  };

  return {
    append(delta) {
      if (ended) return;
      text += delta;
      if (!posting) void post();
      else scheduleEdit();
    },
    async end() {
      ended = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
      if (!posting) return { surface: NAME, conversation: deps.conversation, id: '' };
      await posting;
      if (failed) throw failed;
      if (ts) await runEdit(true);
      return { surface: NAME, conversation: deps.conversation, id: ts ?? '' };
    },
  };
}
