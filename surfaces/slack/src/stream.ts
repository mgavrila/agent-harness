import { describeError, SurfaceError } from '@harness/shared';
import type { StreamHandle } from '@harness/surface-api';
import type { SlackApi } from './transport/types.js';

const NAME = 'slack';

/**
 * How often a streamed reply is edited. `chat.update` is a Tier 3 method (about fifty calls a
 * minute per app); one edit every 1.5 s per reply leaves room for several replies at once and
 * for the approvals loops' own calls.
 */
export const STREAM_EDIT_INTERVAL_MS = 1500;

export interface StreamDeps {
  api: SlackApi;
  conversation: string;
  threadTs?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
}

/**
 * Run one Web API call and turn whatever it throws into a `SurfaceError` — the same wrapping
 * `session.ts` gives every call this adapter makes on its own behalf: the message names the
 * surface and the operation, never the accumulated text or the channel, so it stays safe to
 * write into a plaintext column.
 */
async function guarded<T>(op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new SurfaceError(`${NAME}: ${op} failed: ${describeError(err)}`);
  }
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
 * been armed is cleared outright, so nothing keeps the event loop alive past `end`. A mid-stream
 * edit's failure is swallowed — the text it carried arrives with the next edit or the final one,
 * so failing the whole stream over one rate-limited or transient edit would only drop text
 * nothing else ever resends. A failed first post, or a failed final edit, rejects `end` with a
 * `SurfaceError`, so the host logs it once. `append` after `end` is a no-op: the reply already
 * told the world it was done, and nothing reopens it.
 */
export function createEditStream(deps: StreamDeps): StreamHandle {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setTimeout ?? setTimeout;
  let text = '';
  let ts: string | null = null;
  let posting: Promise<void> | null = null;
  let lastCall = 0;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  let ended = false;

  const post = (): Promise<void> =>
    (posting ??= guarded('chat.postMessage', () =>
      deps.api.chat.postMessage({ channel: deps.conversation, text, thread_ts: deps.threadTs }),
    ).then((res) => {
      ts = res.ts ?? '';
      lastCall = now();
    }));

  const edit = async (): Promise<void> => {
    if (!ts || ended) return;
    lastCall = now();
    await deps.api.chat.update({ channel: deps.conversation, ts, text }).catch(() => undefined);
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
      await edit();
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
      if (ts) {
        const postedTs = ts;
        await guarded('chat.update', () => deps.api.chat.update({ channel: deps.conversation, ts: postedTs, text }));
      }
      return { surface: NAME, conversation: deps.conversation, id: ts ?? '' };
    },
  };
}
