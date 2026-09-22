import type { Logger } from '@harness/shared';
import type { SlackFile } from './files.js';
import type { RawMessage, SlackApi, SlackThreadMessage } from './types.js';

/** How many threads each half of the thread memory holds before the oldest key falls out. */
export const THREAD_MEMORY_LIMIT = 1000;

/** One page of a thread is enough to tell whose it is. */
const THREAD_LOOKUP_LIMIT = 50;

/** How long a failing lookup stays quiet after it has said so once. */
const WARN_INTERVAL_MS = 60_000;

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
 * What an inbound payload means, or null to drop it.
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
  // Slack's own system user posts notices (e.g. "you were added to a channel") into the
  // assistant's DM; its channel cannot be posted to, so this is a person to nobody.
  if (event.user === 'USLACKBOT') return null;
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

/** A bounded store: insertion-ordered, and the oldest entry is what an overflow drops. */
function boundedMap<V>(limit: number): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  delete: (key: string) => void;
} {
  const entries = new Map<string, V>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      if (entries.has(key)) return;
      entries.set(key, value);
      // A `Map` iterates in insertion order, so the first key is the oldest inserted one.
      if (entries.size > limit) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}

/**
 * This app, as the thread lookup knows itself: the user id it posts under and the bot id Slack
 * stamps on its messages. `auth.test` answers with both at start; either may be missing, and a
 * message matching neither was written by somebody else — another bot included.
 */
export interface BotIdentity {
  userId?: string;
  botId?: string;
}

/** Which threads the assistant has posted in, as far as this process can tell. */
export interface ThreadMemory {
  /**
   * Remember which thread an inbound message belongs to, so a reply addressed by that message's
   * own timestamp can be recorded against the thread's root. The host hands a surface the
   * message it is replying to, never the root, and for a reply the two are different strings.
   */
  noteInbound(channel: string, ts: string, threadTs: string): void;
  /** `messageId` is whatever the reply named: a thread root, or a message inside one. */
  notePostedIn(channel: string, messageId: string): void;
  /**
   * The root of the thread `ts` arrived in, or `ts` itself for a message this process never saw.
   *
   * `noteInbound` recorded it when the message was delivered. The fallback is not a guess: for a
   * top-level message the root *is* its own timestamp, and for a reply this process has forgotten
   * — a restart mid-turn, or an eviction from the bounded store — it is the handle the adapter
   * had before this method existed, so nothing gets worse.
   */
  rootOf(channel: string, ts: string): string;
  hasPosted(channel: string, threadTs: string, bot: BotIdentity): Promise<boolean>;
}

/**
 * The threads this process knows about, in two bounded sets of `<channel>:<thread ts>` keys: the
 * ones the assistant has posted in and the ones a lookup said it has not. A third bounded store
 * maps an inbound message's own timestamp to the root of the thread it arrived in, because that
 * timestamp is the only handle the session has when it records a reply.
 *
 * Both sets are empty after a restart, and a thread the assistant answered yesterday is still its
 * thread, so a key in neither set is resolved by asking Slack for the thread once —
 * `conversations.replies`, covered by the `channels:history`, `groups:history` and `mpim:history`
 * scopes the app already holds. The answer is remembered either way, so a busy thread costs one
 * call rather than one per message. A message from the assistant is one written by the bot user,
 * or carrying this app's own bot id; another workspace bot's message is not, or every alert
 * thread a person replies in would be answered as though the assistant had joined it. A thread
 * rooted on one of the assistant's own messages counts too, since it is just as much a party.
 */
export function createThreadMemory(api: Pick<SlackApi, 'conversations'>, log: Logger): ThreadMemory {
  const ours = boundedMap<true>(THREAD_MEMORY_LIMIT);
  const theirs = boundedMap<true>(THREAD_MEMORY_LIMIT);
  const roots = boundedMap<string>(THREAD_MEMORY_LIMIT);
  let warnedAt: number | null = null;

  return {
    noteInbound(channel, ts, threadTs) {
      roots.set(`${channel}:${ts}`, threadTs);
    },
    rootOf(channel, ts) {
      return roots.get(`${channel}:${ts}`) ?? ts;
    },
    notePostedIn(channel, messageId) {
      // A reply is addressed by the message it answers, which inside an existing thread is not
      // that thread's root. Slack folds the reply into the root, so the root is the key a later
      // follow-up arrives under, and recording anything else leaves the thread deaf.
      const root = roots.get(`${channel}:${messageId}`) ?? messageId;
      const key = `${channel}:${root}`;
      ours.set(key, true);
      // The thread was somebody else's until this post; a stale negative entry is consulted
      // before any lookup, so leaving it there would answer for the life of the process.
      theirs.delete(key);
    },
    async hasPosted(channel, threadTs, bot) {
      const key = `${channel}:${threadTs}`;
      if (ours.get(key)) return true;
      if (theirs.get(key)) return false;
      let messages: SlackThreadMessage[];
      try {
        const res = await api.conversations.replies({ channel, ts: threadTs, limit: THREAD_LOOKUP_LIMIT });
        messages = res.messages ?? [];
      } catch (err) {
        // Nothing is cached: a failure is not an answer, and the next message asks again. Every
        // uncached thread reply is dropped while this is failing, so the line repeats — rate
        // limited to one a minute, because a busy thread would otherwise write it every time.
        const now = Date.now();
        if (warnedAt === null || now - warnedAt >= WARN_INTERVAL_MS) {
          warnedAt = now;
          log.warn('could not read a Slack thread to see whether this assistant has posted in it', err);
        }
        return false;
      }
      // Whatever the outage was, it is over: the next one gets its own first line.
      warnedAt = null;
      const posted = messages.some(
        (m) =>
          (bot.userId !== undefined && m.user === bot.userId) || (bot.botId !== undefined && m.bot_id === bot.botId),
      );
      (posted ? ours : theirs).set(key, true);
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
  bot: BotIdentity,
  threads: ThreadMemory,
): Promise<Classified | null> {
  const classified = classifyMessage(event, bot.userId);
  if (!classified || classified.mentioned || classified.threadTs === undefined) return classified;
  if (!(await threads.hasPosted(event.channel, classified.threadTs, bot))) return classified;
  return { ...classified, mentioned: true };
}
