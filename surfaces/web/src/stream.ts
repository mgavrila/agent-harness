/**
 * Server-Sent Events, per conversation, framed here and written by the host as opaque chunks.
 *
 * The whole format is `id: <n>\nevent: <name>\ndata: <one JSON line>\n\n`, with `: <text>\n\n`
 * for a comment, so a library would be a dependency for forty lines of string building — and the
 * framing is the one thing this adapter must own, because the host writes chunks it does not read
 * (spec section 4.9, "what the host learns: nothing").
 *
 * Ids count from 1 **per conversation**, so two pages of the workspace resume independently, and
 * a client reconnects with `Last-Event-ID`.
 */

/**
 * The five frames this surface sends. Named here because the README and the runbook list them.
 *
 * Two of the five carry more than one payload, and a client discriminates on a key rather than on
 * the name, so both are written down here:
 *
 * - `card` is `{ message, card }` for a posted card and `{ form }` for a dialogue this surface
 *   was asked to open. A form has no message of its own — it is opened from a button — which is
 *   why it is not a sixth name: the workspace is being asked to render something in the same
 *   place, and the key says which.
 * - `notice` is `{ message, text, replyTo }` for something the host said *about* a message,
 *   `{ text, userId }` for a private note the workspace routes to one person, and
 *   `{ text, dropped: true }` for the one this surface sends itself, when a resume has fallen
 *   past the window.
 */
export const WEB_EVENTS = ['delta', 'message', 'card', 'card_update', 'notice'] as const;
export type WebEvent = (typeof WEB_EVENTS)[number];

/**
 * How many frames one conversation holds for a client that resumes.
 *
 * In memory, per host, and dropped when the tenant closes (spec section 13.5 leaves the window
 * open and asks for a decision before the stream is written; this is it). Two hundred frames is
 * minutes of a conversation and kilobytes per tenant. The cost is stated rather than hidden: a
 * workspace behind an ingress with two hosts can resume only against the host it reconnects to,
 * and a resume that lands anywhere else opens with the dropped-frames notice below — which is
 * exactly the signal the workspace needs to reload the conversation from the run API instead.
 */
export const WEB_FRAME_RETENTION = 200;

/** How often an idle stream writes a comment line, for the reason `SSE_KEEPALIVE_MS` exists. */
export const WEB_KEEPALIVE_MS = 15_000;

/** What a client is told when it resumes past the window. It carries no id; see `open`. */
const DROPPED_NOTICE = { text: 'Some earlier messages are no longer available.', dropped: true };

interface Frame {
  id: number;
  event: WebEvent;
  data: unknown;
}

interface Conversation {
  frames: Frame[];
  seq: number;
}

export interface ConversationStreamsOptions {
  /** Zero switches the keep-alive off, which is what a test that counts frames wants. */
  keepAliveMs?: number;
}

/** One conversation's frames, and everyone listening to it. */
export class ConversationStreams {
  /** How many streams are open right now, across every conversation. */
  openCount = 0;

  private readonly conversations = new Map<string, Conversation>();
  private readonly waiting = new Set<() => void>();
  private readonly keepAliveMs: number;

  constructor(opts: ConversationStreamsOptions = {}) {
    this.keepAliveMs = opts.keepAliveMs ?? WEB_KEEPALIVE_MS;
  }

  /** How many frames a conversation is holding. A conversation nobody has used holds none. */
  held(conversation: string): number {
    return this.conversations.get(conversation)?.frames.length ?? 0;
  }

  /**
   * Add one frame to a conversation and wake everyone listening to it.
   *
   * A conversation is created by writing to it, which is why there is no route to create one and
   * none to list them (spec section 4.9).
   */
  emit(conversation: string, event: WebEvent, data: unknown): void {
    const held = this.conversations.get(conversation) ?? { frames: [], seq: 0 };
    held.seq += 1;
    held.frames.push({ id: held.seq, event, data });
    if (held.frames.length > WEB_FRAME_RETENTION) held.frames.shift();
    this.conversations.set(conversation, held);
    // A copy, because a waiter removes itself from the set as it runs.
    for (const waiter of [...this.waiting]) waiter();
  }

  /**
   * One client's view of a conversation: what it has not seen, then whatever arrives.
   *
   * `lastEventId` is the `Last-Event-ID` header, which reaches an adapter as the lower-cased
   * `last-event-id` key of the request's headers. A resume the window no longer covers opens with
   * a `notice` frame carrying `dropped: true` **and no `id:` line** — a client's `Last-Event-ID`
   * must not move to a frame that is an apology rather than a message, or a second reconnection
   * would skip a real one.
   */
  open(conversation: string, signal: AbortSignal, lastEventId: string | null): AsyncIterable<string> {
    const asked = Number.parseInt(lastEventId ?? '', 10);
    const resumeAfter = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
    return this.stream(conversation, signal, resumeAfter);
  }

  private async *stream(conversation: string, signal: AbortSignal, resumeAfter: number): AsyncGenerator<string> {
    this.openCount += 1;
    try {
      let sent = resumeAfter;
      if (resumeAfter > 0) {
        const oldest = this.conversations.get(conversation)?.frames[0]?.id ?? resumeAfter + 1;
        if (oldest > resumeAfter + 1) yield `event: notice\ndata: ${JSON.stringify(DROPPED_NOTICE)}\n\n`;
      }
      for (;;) {
        const next = (this.conversations.get(conversation)?.frames ?? []).filter((frame) => frame.id > sent);
        if (next.length > 0) {
          for (const frame of next) {
            sent = frame.id;
            yield `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
          }
          continue;
        }
        // After the backlog, not before it — the same rule `MemorySurface`'s door follows, so the
        // seam's reference implementation and its first real one cannot disagree about what a
        // caller who has already hung up receives.
        if (signal.aborted) return;
        if (await this.pause(signal)) yield ': keep-alive\n\n';
      }
    } finally {
      // `finally`, so an abort, a throw and a consumer that simply stops pulling all close it.
      this.openCount -= 1;
    }
  }

  /**
   * Park until a frame arrives, the caller goes away, or the keep-alive falls due.
   *
   * True means the timer fired and the caller should write a comment line. The timer is `unref`ed
   * for the reason the run API's is: an idle stream must not be why a process will not exit.
   */
  private async pause(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const settle = (keepAlive: boolean) => (): void => {
        this.waiting.delete(wake);
        signal.removeEventListener('abort', abort);
        if (timer !== undefined) clearTimeout(timer);
        resolve(keepAlive);
      };
      const wake = settle(false);
      const abort = settle(false);
      const timer = this.keepAliveMs > 0 ? setTimeout(settle(true), this.keepAliveMs) : undefined;
      timer?.unref();
      this.waiting.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
