import { App, LogLevel } from '@slack/bolt';
import type { Logger } from '@harness/shared';
import type { SlackConfig } from '../config.js';
import { downloadAttachments, type SlackFile } from './files.js';
import type {
  RawMessage,
  SlackApi,
  SlackAction,
  SlackEvents,
  SlackInbound,
  SlackThreadMessage,
  SlackTransport,
  SlackView,
} from './types.js';
import { webClientApi } from './web-client.js';

/** How many threads each half of the thread memory holds before the oldest key falls out. */
export const THREAD_MEMORY_LIMIT = 1000;

/** One page of a thread is enough to tell whose it is. */
const THREAD_LOOKUP_LIMIT = 50;

/** What an inbound payload meant, before the thread rule had its say. */
export interface Classified {
  userId: string;
  text: string;
  mentioned: boolean;
  files: SlackFile[];
  /**
   * The thread this message is a reply in, set only when nothing else has addressed it. Whether
   * that thread makes it addressed is a question only an async lookup answers, so it is reported
   * here and decided by the caller; `classifyMessage` stays pure.
   */
  threadTs?: string;
}

/**
 * What an inbound payload means, or null to drop it (decision 1 of Plan 8b).
 *
 * `app_mention` is the one event that says the assistant was addressed at a channel's top level; a
 * channel `message` that carries the mention is the same message arriving a second time (when the
 * bot is a member) and is dropped. A direct message is addressed by construction and is kept even
 * when it names the bot, with the token stripped. Bots, edits, deletions and joins are not messages
 * from a person; a `file_share` is.
 *
 * A reply written inside a thread is the other way a person addresses the assistant: the thread is
 * the conversation, so once the assistant has posted there a follow-up needs no mention. That
 * message carries no token to strip and its text is passed through untouched.
 */
export function classifyMessage(event: RawMessage, botUserId: string | undefined): Classified | null {
  if (event.bot_id || !event.user) return null;
  const mention = botUserId ? `<@${botUserId}>` : null;
  const text = event.text ?? '';
  const files = (event.files ?? [])
    .filter(
      (f): f is { name: string; url_private_download: string } =>
        typeof f.name === 'string' && typeof f.url_private_download === 'string',
    )
    .map((f) => ({ name: f.name, url: f.url_private_download }));
  if (event.type === 'app_mention') {
    return {
      userId: event.user,
      text: mention ? text.replaceAll(mention, '').trim() : text.trim(),
      mentioned: true,
      files,
    };
  }
  if (event.subtype !== undefined && event.subtype !== 'file_share') return null;
  const direct = event.channel_type === 'im';
  // In a channel the same message arrives twice when the bot is a member, once as `app_mention`;
  // this is the copy to drop. A direct message is addressed by construction and `app_mention` is
  // documented for channels, so a DM is kept whether or not it names the bot — dropping it would
  // silently lose a message the person expects an answer to.
  if (!direct && mention && text.includes(mention)) return null;
  const stripped = direct && mention ? text.replaceAll(mention, '') : text;
  // A reply names its parent in `thread_ts`; a top-level message names itself there once it has
  // replies of its own, which is not a reply. A direct message needs no thread rule to be heard.
  const inThread = !direct && event.thread_ts !== undefined && event.thread_ts !== event.ts;
  return {
    userId: event.user,
    text: stripped.trim(),
    mentioned: direct,
    files,
    ...(inThread ? { threadTs: event.thread_ts } : {}),
  };
}

/** A bounded set of keys: insertion-ordered, and the oldest is what an overflow drops. */
function boundedKeys(limit: number): { has: (key: string) => boolean; add: (key: string) => void } {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      if (keys.has(key)) return;
      keys.add(key);
      // A `Set` iterates in insertion order, so the first key is the least recently added one.
      if (keys.size > limit) {
        const oldest = keys.values().next();
        if (!oldest.done) keys.delete(oldest.value);
      }
    },
  };
}

/** Which threads the assistant has posted in, as far as this process can tell. */
export interface ThreadMemory {
  notePostedIn(channel: string, threadTs: string): void;
  hasPosted(channel: string, threadTs: string, botUserId: string | undefined): Promise<boolean>;
}

/**
 * The threads this process knows about, in two bounded sets of `<channel>:<thread ts>` keys: the
 * ones the assistant has posted in and the ones a lookup said it has not.
 *
 * Both sets are empty after a restart, and a thread the assistant answered yesterday is still its
 * thread, so a key in neither set is resolved by asking Slack for the thread once —
 * `conversations.replies`, covered by the `channels:history`, `groups:history` and `im:history`
 * scopes the app already holds. The answer is remembered either way, so a busy thread costs one
 * call rather than one per message. A message from the assistant is one carrying a `bot_id` or
 * written by the bot user; a thread rooted on such a message counts too, since the assistant is
 * just as much a party to it.
 */
export function createThreadMemory(api: Pick<SlackApi, 'conversations'>, log: Logger): ThreadMemory {
  const ours = boundedKeys(THREAD_MEMORY_LIMIT);
  const theirs = boundedKeys(THREAD_MEMORY_LIMIT);
  let warned = false;

  return {
    notePostedIn(channel, threadTs) {
      ours.add(`${channel}:${threadTs}`);
    },
    async hasPosted(channel, threadTs, botUserId) {
      const key = `${channel}:${threadTs}`;
      if (ours.has(key)) return true;
      if (theirs.has(key)) return false;
      let messages: SlackThreadMessage[];
      try {
        const res = await api.conversations.replies({ channel, ts: threadTs, limit: THREAD_LOOKUP_LIMIT });
        messages = res.messages ?? [];
      } catch (err) {
        // Nothing is cached: a failure is not an answer, and the next message asks again. Logged
        // once, because a thread that keeps talking would otherwise write this line every time.
        if (!warned) {
          warned = true;
          log.warn('could not read a Slack thread to see whether this assistant has posted in it', err);
        }
        return false;
      }
      const posted = messages.some((m) => m.bot_id !== undefined || (botUserId !== undefined && m.user === botUserId));
      (posted ? ours : theirs).add(key);
      return posted;
    },
  };
}

/**
 * `classifyMessage` and then the thread rule, which is the whole of what an inbound payload
 * means. Split in two because the lookup behind the thread rule is a Web API call and the
 * classifier itself is worth keeping pure.
 */
export async function classifyInbound(
  event: RawMessage,
  botUserId: string | undefined,
  threads: ThreadMemory,
): Promise<Classified | null> {
  const classified = classifyMessage(event, botUserId);
  if (!classified || classified.mentioned || classified.threadTs === undefined) return classified;
  if (!(await threads.hasPosted(event.channel, classified.threadTs, botUserId))) return classified;
  return { ...classified, mentioned: true };
}

/**
 * A real Slack connection, in Socket Mode.
 *
 * One app now carries chat and approvals, because one process — this host — holds both
 * connections; the "two apps" reasoning from before Plan 8b is gone with the second process.
 * Slack still routes each Socket Mode event to exactly one open connection per app, but there is
 * only one connection now, so there is nothing to split between.
 *
 * Both the action and the view registrations are catch-alls. The contract takes one action
 * handler and one view handler and dispatches on the id itself, so there is nothing for Bolt to
 * route. Every interaction Slack delivers is acknowledged, and one this host did not post is
 * acked and dropped by the handler above rather than ignored by Bolt. Acking something unknown
 * costs nothing; leaving it unacked makes Slack show the user an error for a message the host
 * has no opinion about.
 */
export function boltTransport(config: SlackConfig, log: Logger, storageDir: string): SlackTransport {
  const bolt = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const api = webClientApi(bolt.client);
  const threads = createThreadMemory(api, log);

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;
  let messageHandler: ((message: SlackInbound) => Promise<void>) | null = null;

  /** Slack drops an interaction that is not acknowledged within three seconds. */
  const ackFirst = async (ack: () => Promise<unknown>): Promise<void> => {
    try {
      await ack();
    } catch (err) {
      log.error('ack failed', err);
    }
  };

  bolt.action(/.*/, async ({ ack, body, action }) => {
    await ackFirst(ack);
    if (!actionHandler) {
      log.warn('a Slack action arrived before a handler was registered');
      return;
    }
    await actionHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      // The channel the interactive message lives in.
      channel: (body as { channel?: { id?: string } }).channel?.id ?? '',
      actionId: (action as { action_id?: string }).action_id ?? '',
      value: (action as { value?: string }).value ?? '',
      triggerId: (body as { trigger_id?: string }).trigger_id ?? null,
      messageTs: (body as { message?: { ts?: string } }).message?.ts ?? null,
    });
  });

  bolt.view(/.*/, async ({ ack, body, view }) => {
    await ackFirst(ack);
    if (!viewHandler) {
      log.warn('a Slack view submission arrived before a handler was registered');
      return;
    }
    await viewHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      callbackId: view.callback_id,
      privateMetadata: view.private_metadata ?? '',
      state: (view.state as { values?: Record<string, Record<string, { value?: string | null }>> }).values ?? {},
    });
  });

  const deliver = async (raw: RawMessage, botUserId: string | undefined): Promise<void> => {
    if (!messageHandler) {
      log.warn('a Slack message arrived before a handler was registered');
      return;
    }
    const classified = await classifyInbound(raw, botUserId, threads);
    if (!classified) return;
    const files = await downloadAttachments(raw.ts, classified.files, { token: config.botToken, storageDir, log });
    await messageHandler({
      userId: classified.userId,
      channel: raw.channel,
      text: classified.text,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      mentioned: classified.mentioned,
      files,
    });
  };
  bolt.event('message', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));
  bolt.event('app_mention', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    start: () => bolt.start().then(() => undefined),
    stop: () => bolt.stop().then(() => undefined),
  };

  return { api, events, notePostedIn: (channel, threadTs) => threads.notePostedIn(channel, threadTs) };
}
