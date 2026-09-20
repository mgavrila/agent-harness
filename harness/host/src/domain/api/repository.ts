import { and, desc, eq } from 'drizzle-orm';
import { messages, runs, threads, type Db } from '@harness/db';
import { API_THREAD_MESSAGES } from './types.js';

export interface ApiThread {
  id: string;
  surface: string;
  conversation: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface ApiMessage {
  role: string;
  content: string;
  created_at: string;
}

/**
 * This run, if it is this client's and this principal's.
 *
 * Both halves of that are the point (decision 18): a run of another principal answers exactly what
 * a run that never existed answers, so the API never confirms that someone else's run is there.
 */
export async function findRunFor(
  db: Db,
  input: { client: string; principalId: string; runId: string },
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.client, input.client), eq(runs.principalId, input.principalId)))
    .limit(1);
  return row ?? null;
}

/**
 * This thread and its most recent messages, **newest last**, if it is this client's and this
 * principal's.
 *
 * Read newest-first under the limit and then reversed, which is the only way to take the *tail* of
 * a long thread: `ORDER BY … ASC LIMIT 200` would hand back the two hundred oldest messages, so a
 * caller reading a thread that had run for a month would see how it started and never how it was
 * going. The caller wants the recent end, and gets it in reading order.
 *
 * Ordered by `(created_at, seq)`: two rows written by one transaction carry one timestamp, and
 * `seq` is the tiebreak every ordered read of `messages` uses.
 */
export async function readThreadFor(
  db: Db,
  input: { client: string; principalId: string; threadId: string },
): Promise<{ thread: ApiThread; messages: ApiMessage[] } | null> {
  const [thread] = await db
    .select()
    .from(threads)
    .where(
      and(eq(threads.id, input.threadId), eq(threads.client, input.client), eq(threads.principalId, input.principalId)),
    )
    .limit(1);
  if (!thread) return null;
  const newestFirst = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    // Belt and braces (spec invariant 13): the thread above is already this client's, and a
    // message row that says otherwise is a writer's bug this read makes visible rather than one
    // it hands to the caller.
    .where(and(eq(messages.client, input.client), eq(messages.threadId, thread.id)))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(API_THREAD_MESSAGES);
  const rows = newestFirst.reverse();
  return {
    thread: {
      id: thread.id,
      surface: thread.surface,
      conversation: thread.conversation,
      kind: thread.kind,
      created_at: thread.createdAt.toISOString(),
      updated_at: thread.updatedAt.toISOString(),
    },
    messages: rows.map((row) => ({
      role: row.role,
      content: row.content,
      created_at: row.createdAt.toISOString(),
    })),
  };
}
