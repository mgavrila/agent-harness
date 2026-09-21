import {
  SurfaceError,
  type ActionEvent,
  type Card,
  type Form,
  type FormEvent,
  type MessageEvent,
  type MessageRef,
  type StreamHandle,
  type SurfaceDeps,
  type SurfaceSession,
  type UploadRequest,
} from './deps.js';
import { webConfig } from './config.js';
import { createDoor, type WebInbound } from './door.js';
import { ConversationStreams } from './stream.js';

const NAME = 'web';

/**
 * How many triggers and open forms one session remembers.
 *
 * Both are short-lived handles a workspace hands straight back, so a bound of a few hundred is
 * generous; what it is really for is a session that runs for weeks without one growing.
 */
const HANDLE_LIMIT = 200;

/**
 * Where one open form's metadata is remembered: the card it was opened from, and its id.
 *
 * **Not the conversation.** Every approval card a tenant raises goes to the one inbox and the
 * host's edit dialogue has a single, constant form id, so a key of `(conversation, formId)` would
 * let a second Edit press overwrite the first one's metadata — and the metadata is what names the
 * approval being decided. Two people editing two approvals in one inbox would then decide the
 * same one twice. A message reference is unique per posted card, which is exactly the grain a
 * form instance has.
 */
const formKey = (message: MessageRef, formId: string): string => `${message.conversation}:${message.id}:${formId}`;

/** A bounded map: the oldest entry goes when a new one would push it past the limit. */
class Recent<T> {
  private readonly entries = new Map<string, T>();

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > HANDLE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Read an entry and forget it, so a handle that is used once cannot be used twice. */
  take(key: string): T | undefined {
    const found = this.entries.get(key);
    this.entries.delete(key);
    return found;
  }
}

/**
 * A session with one member of its own: the deliveries its door has acknowledged.
 *
 * The contract has no `settled`, and should not — it is a thing a *test* needs of an adapter that
 * answers before it delivers, and the host never waits on one. `MemorySurface` carries the same
 * member for the same reason.
 */
export interface WebSession extends SurfaceSession {
  settled(): Promise<void>;
}

/**
 * The web surface: a conversation with an agent, over HTTP, for a tenant with no Slack.
 *
 * Every outbound call becomes a frame on the conversation's stream, and every inbound one arrives
 * at the door (`door.ts`) and is delivered here. What the host sees is a `SurfaceSession` like any
 * other: it posts cards to `defaultConversation`, resolves the writer through the tenant's
 * identity plug-in, and knows nothing about routes, frames or bearers.
 */
export function createWebSession(deps: SurfaceDeps): WebSession {
  const config = webConfig(deps);
  const streams = new ConversationStreams();
  const triggers = new Recent<MessageRef>();
  const forms = new Recent<string>();
  /** The deliveries this door has acknowledged and not yet finished, so a caller can await them. */
  const delivering = new Set<Promise<void>>();
  let seq = 0;
  let handles = 0;
  let messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
  let actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  let formHandler: ((event: FormEvent) => Promise<void>) | null = null;
  let stopped = false;

  const ref = (conversation: string): MessageRef => {
    seq += 1;
    return { surface: NAME, conversation, id: `w${seq}` };
  };

  const inbound: WebInbound = {
    token: config.token,
    storageDir: config.storageDir,
    streams,
    inboundRef: ref,
    triggerFor(message) {
      handles += 1;
      const trigger = `t${handles}`;
      // The **message**, not its conversation: a form opened from this press belongs to the card
      // it was pressed on, and every one of a tenant's cards is in the same inbox.
      triggers.set(trigger, message);
      return trigger;
    },
    takeForm: (message, formId) => forms.take(formKey(message, formId)) ?? null,
    /**
     * Start work this request has already been acknowledged for; a failure is a log line.
     *
     * On a later tick rather than now, for the reason the Slack transport gives: `void run()`
     * alone would execute everything up to the turn's first real suspension before the 202 it is
     * owed had been built.
     *
     * Each delivery is held in `delivering` until it settles, so `settled()` can await them. That
     * is not a convenience: a door that answers before it delivers leaves a turn opening a run
     * and writing `messages` rows after the case that started it has returned, and the next
     * case's `TRUNCATE` deadlocks against it (`40P01`). `MemorySurface` carries the same set for
     * the same reason, and `settleDeliveries` in the host's fixture awaits both.
     */
    deliver(what, run) {
      setImmediate(() => {
        // `try` as well as `catch`: a handler that threw where it stands rather than rejecting
        // would escape a bare `.catch` and, at the top of the event loop, take the process down.
        try {
          const delivery = run().catch((err: unknown) => deps.log.error(`${what} failed`, err));
          delivering.add(delivery);
          void delivery.finally(() => delivering.delete(delivery));
        } catch (err: unknown) {
          deps.log.error(`${what} failed`, err);
        }
      });
    },
    async message(event) {
      if (!messageHandler) {
        deps.log.warn('a web message arrived before a handler was registered');
        return;
      }
      await messageHandler(event);
    },
    async action(event) {
      if (!actionHandler) {
        deps.log.warn('a web action arrived before a handler was registered');
        return;
      }
      await actionHandler(event);
    },
    async form(event) {
      if (!formHandler) {
        deps.log.warn('a web form submission arrived before a handler was registered');
        return;
      }
      await formHandler(event);
    },
  };

  /** Every outbound call goes through here, so a stopped session posts nowhere. */
  const emit = (conversation: string, event: Parameters<ConversationStreams['emit']>[1], data: unknown): void => {
    if (stopped) throw new SurfaceError(`${NAME}: this session has been stopped`);
    streams.emit(conversation, event, data);
  };

  /**
   * One outbound call's answer: what it produced, or a rejection carrying what went wrong.
   *
   * Every posting method answers with a promise and none of them has anything to await — a frame
   * is pushed into memory and the host's writer picks it up — so `async` here would be a
   * signature nobody checked. This is the shape `surfaces/http` already uses for the same reason:
   * the contract says a method that talks to the outside world *rejects*, and a synchronous throw
   * escapes before the caller has a promise to attach to. `startStream` is the contract's own
   * exception: it hands back a handle rather than a promise, so `append` throws where it stands.
   */
  const outbound = <T>(produce: () => T): Promise<T> => {
    try {
      return Promise.resolve(produce());
    } catch (err) {
      // Narrowed rather than passed through: everything thrown below is a `SurfaceError`, and a
      // rejection reason that is not an error is a thing a caller cannot log.
      return Promise.reject(err instanceof Error ? err : new SurfaceError(`${NAME}: an outbound call failed`));
    }
  };

  return {
    name: NAME,
    capabilities: { streaming: true, update: true, forms: true, privateReply: true, inlineConfirm: false },
    defaultConversation: config.inbox,
    http: createDoor(inbound),

    /**
     * `@<userId>`, and deliberately not a display name.
     *
     * A surface is handed a user id and nothing else; the display name a rules block renders is
     * the identity plug-in's answer, on every surface, and inventing a body field to carry one
     * would be inventing a contract (plan decision 7).
     */
    mention: (userId) => `@${userId}`,

    postCard(conversation, card: Card) {
      return outbound(() => {
        const message = ref(conversation);
        emit(conversation, 'card', { message, card });
        return message;
      });
    },

    updateCard(message, card: Card) {
      return outbound(() => {
        emit(message.conversation, 'card_update', { message, card });
      });
    },

    postText(conversation, text, opts = {}) {
      return outbound(() => {
        const message = ref(conversation);
        emit(conversation, opts.kind === 'notice' ? 'notice' : 'message', {
          message,
          text,
          replyTo: opts.replyTo ?? null,
        });
        return message;
      });
    },

    postPrivate(conversation, userId, text) {
      // The stream is per conversation and is read by the workspace rather than by one person's
      // browser, so a private note names who it is for and the workspace routes it. That is what
      // `privateReply` means on a surface whose client is a server.
      return outbound(() => {
        emit(conversation, 'notice', { text, userId });
      });
    },

    uploadFile(conversation, file: UploadRequest) {
      return outbound(() => {
        const message = ref(conversation);
        // The bytes stay on the host: this frame says a file was released and names it, and how
        // the workspace fetches it is its own business — there is no route here that serves one.
        emit(conversation, 'message', {
          message,
          text: file.comment ?? `Sent a file: ${file.filename}`,
          file: { filename: file.filename },
          replyTo: file.replyTo ?? null,
        });
        return { filename: file.filename };
      });
    },

    openForm(trigger, form: Form) {
      return outbound(() => {
        const message = triggers.take(trigger);
        if (message === undefined) throw new SurfaceError(`${NAME}: that trigger is no longer open`);
        // Remembered against the card it was opened from, and handed back untouched when the
        // submission names that card. The adapter never reads it: it is the host's own string.
        forms.set(formKey(message, form.id), form.metadata);
        // The frame carries the card too, so the workspace knows which dialogue this is and what
        // to send back as `messageRef`: a form has no message of its own.
        emit(message.conversation, 'card', { message, form });
      });
    },

    onAction(handler) {
      actionHandler = handler;
    },
    onFormSubmit(handler) {
      formHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },

    startStream(conversation, opts = {}) {
      const message = ref(conversation);
      let text = '';
      return {
        append: (delta) => {
          text += delta;
          emit(conversation, 'delta', { message, delta });
        },
        end: () =>
          outbound(() => {
            emit(conversation, 'message', { message, text, replyTo: opts.replyTo ?? null });
            return message;
          }),
      } satisfies StreamHandle;
    },

    /**
     * Wait for every delivery this door has acknowledged, to the end of its turn.
     *
     * Not part of `SurfaceSession` — it is this adapter's own, the way `MemorySurface.settled` is
     * — and the host's test fixture calls it on any session that has one. It is **not** called
     * from `stop()`: `quiesce` stops a tenant's sessions *before* it drains them, so a `stop`
     * that awaited a whole turn would make a document edit wait out that turn unbounded, where
     * the drain that follows it is bounded on purpose.
     */
    settled: async (): Promise<void> => {
      await Promise.all(delivering);
    },

    /** Nothing to open: the host mounts the door and hands over what arrives. */
    start: () => Promise.resolve(),
    /**
     * Drop the handlers, so a tenant that is shutting down cannot be delivered into by a request
     * that arrives while its surfaces are being stopped, and post nowhere afterwards — and end
     * every stream this session is holding open.
     *
     * The streams matter as much as the handlers. A document edit stops this session and opens a
     * new one with a `ConversationStreams` of its own, so a stream left parked here would keep a
     * socket open on a session nothing will ever post to again: a workspace would watch a live
     * connection that had silently gone deaf. Ending the iterables ends the responses, the client
     * reconnects, and its `Last-Event-ID` reaches a host that cannot place it — which `open`
     * answers with the dropped notice and the whole window.
     */
    stop: () => {
      stopped = true;
      messageHandler = null;
      actionHandler = null;
      formHandler = null;
      streams.close();
      return Promise.resolve();
    },
  };
}
