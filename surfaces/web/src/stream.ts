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
 * and a resume that lands anywhere else opens with the dropped-frames notice below and then the
 * whole of that host's window — which is exactly the signal the workspace needs to reload the
 * conversation from the run API instead.
 *
 * The number of *conversations* a session holds is not bounded: a bearer holder may name as many
 * ids as it likes and each one costs up to this many frames until the tenant closes. The caller
 * is the tenant's own workspace, authenticated by a bearer only the control plane holds, so this
 * is a note rather than a gap; a least-recently-used bound over conversations is the fix if a
 * deployment ever wants one.
 */
export const WEB_FRAME_RETENTION = 200;

/** How often an idle stream writes a comment line, for the reason `SSE_KEEPALIVE_MS` exists. */
export const WEB_KEEPALIVE_MS = 15_000;

/**
 * What a client is told when its resume point cannot be honoured. It carries no id; see `open`.
 *
 * One sentence, whichever way it happened, because there is only one thing a person can be told.
 * The machine-readable half is `reason`, which a workspace can act on differently: `window` is a
 * client that was away longer than this host remembers, and the other two mean this host has no
 * such history at all — it restarted, the tenant was reloaded, or an ingress sent the
 * reconnection to a different host.
 */
const DROPPED_TEXT = 'Some earlier messages are no longer available.';

/**
 * Why a `Last-Event-ID` could not be honoured.
 *
 * - `window`: the id is older than the oldest frame still held.
 * - `unknown`: this host has never written to that conversation.
 * - `ahead`: the id is ahead of every frame that conversation has, so it was minted somewhere
 *   else — another host, or this one before it restarted.
 */
export type DroppedReason = 'window' | 'unknown' | 'ahead';

interface Frame {
  id: number;
  event: WebEvent;
  data: unknown;
}

/**
 * One frame on the wire, which is the only place this format is written.
 *
 * `id` is omitted for the dropped notice and for nothing else: a client's `Last-Event-ID` must
 * not move to a frame that is an apology rather than a message (see `open`).
 */
const wire = (event: WebEvent, data: unknown, id?: number): string =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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
  /** Set by `close`: every open stream ends, and a stream opened afterwards ends at once. */
  private closed = false;

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
    this.wake();
  }

  /**
   * End every open stream, and every stream opened after this.
   *
   * A session is stopped before its tenant is evicted — a document edit reloads the tenant, and
   * the new one has a `ConversationStreams` of its own — so a stream left parked here would hold
   * a socket open on a session nothing will ever post to again, showing a workspace a live
   * connection that has silently gone deaf. Ending the iterable ends the response, the client
   * reconnects, and the reconnection is a resume this host cannot place: `open` answers it with
   * the dropped notice and the whole window, which is the honest version of what happened.
   *
   * Each stream drains what it is holding first, for the same reason an aborted one does: frames
   * already produced are the client's.
   */
  close(): void {
    this.closed = true;
    this.wake();
  }

  /** Wake everyone parked in `pause`. A copy, because a waiter removes itself as it runs. */
  private wake(): void {
    for (const waiter of [...this.waiting]) waiter();
  }

  /**
   * One client's view of a conversation: what it has not seen, then whatever arrives.
   *
   * `lastEventId` is the `Last-Event-ID` header, which reaches an adapter as the lower-cased
   * `last-event-id` key of the request's headers.
   *
   * A resume this host cannot honour exactly — the window has moved past it, the conversation is
   * one this host has never written to, or the id is ahead of everything that conversation has —
   * opens with a `notice` frame carrying `dropped: true` and the reason, **and no `id:` line**: a
   * client's `Last-Event-ID` must not move to a frame that is an apology rather than a message,
   * or a second reconnection would skip a real one. What follows the notice is the whole retained
   * window, exactly as a fresh open gets, because the alternative is to withhold frames from a
   * client that asked for its history and cannot be told it was refused.
   */
  open(conversation: string, signal: AbortSignal, lastEventId: string | null): AsyncIterable<string> {
    const asked = Number.parseInt(lastEventId ?? '', 10);
    const resumeAfter = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
    return this.stream(conversation, signal, resumeAfter);
  }

  /**
   * Why this host cannot carry on from `resumeAfter`, or null when it can.
   *
   * Three ways to be unplaceable and one answer to all of them, because from the client's side
   * they are the same event: the history it is holding does not continue here.
   */
  private unplaceable(conversation: string, resumeAfter: number): DroppedReason | null {
    const held = this.conversations.get(conversation);
    const oldest = held?.frames[0]?.id;
    if (held === undefined || oldest === undefined) return 'unknown';
    if (resumeAfter > held.seq) return 'ahead';
    return oldest > resumeAfter + 1 ? 'window' : null;
  }

  private async *stream(conversation: string, signal: AbortSignal, resumeAfter: number): AsyncGenerator<string> {
    this.openCount += 1;
    try {
      let sent = resumeAfter;
      const dropped = resumeAfter > 0 ? this.unplaceable(conversation, resumeAfter) : null;
      if (dropped !== null) {
        // Say so once, then send everything held. `sent` goes back to zero rather than staying at
        // the client's id: an id from another host, or from this one before it restarted, would
        // otherwise filter out every frame this conversation goes on to produce.
        sent = 0;
        yield wire('notice', { text: DROPPED_TEXT, dropped: true, reason: dropped });
      }
      for (;;) {
        const next = (this.conversations.get(conversation)?.frames ?? []).filter((frame) => frame.id > sent);
        if (next.length > 0) {
          for (const frame of next) {
            sent = frame.id;
            yield wire(frame.event, frame.data, frame.id);
          }
          continue;
        }
        // After the backlog, not before it — the same rule `MemorySurface`'s door follows, so the
        // seam's reference implementation and its first real one cannot disagree about what a
        // caller who has already hung up receives. A closed session ends the same way, and for
        // the same reason: what was already produced is the client's.
        if (signal.aborted || this.closed) return;
        if (await this.pause(signal)) yield ': keep-alive\n\n';
      }
    } finally {
      // `finally`, so an abort, a throw, a closed session and a consumer that lets go of the
      // iterator all close it. The host aborts the request's signal when the socket closes, which
      // is what ends a stream nobody is reading.
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
        this.waiting.delete(done);
        signal.removeEventListener('abort', done);
        if (timer !== undefined) clearTimeout(timer);
        resolve(keepAlive);
      };
      // One closure for both ways of being woken early, so unregistering either unregisters both.
      const done = settle(false);
      const timer = this.keepAliveMs > 0 ? setTimeout(settle(true), this.keepAliveMs) : undefined;
      timer?.unref();
      this.waiting.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
