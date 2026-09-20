import { and, desc, eq } from 'drizzle-orm';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { messages, threads, withTransaction, type Db } from '@harness/db';
import type { RunHistoryTurn } from '@harness/runtime-api';

export interface ThreadKey {
  client: string;
  surface: string;
  conversation: string;
  principalId: string;
}

export type ThreadRow = typeof threads.$inferSelect;

/** What a message becomes when it trips the redaction check. Invariant 10: never the value. */
export const WITHHELD = '(withheld: it did not pass the redaction check)';

/** The thread for this person in this conversation, created on first contact. Idempotent under the unique index. */
export async function findOrCreateThread(
  db: Db,
  key: ThreadKey,
  kind: 'chat' | 'playbook' = 'chat',
): Promise<ThreadRow> {
  const where = and(
    eq(threads.client, key.client),
    eq(threads.surface, key.surface),
    eq(threads.conversation, key.conversation),
    eq(threads.principalId, key.principalId),
  );
  const existing = await db.query.threads.findFirst({ where });
  if (existing) return existing;
  await db
    .insert(threads)
    .values({ ...key, kind })
    .onConflictDoNothing();
  const row = await db.query.threads.findFirst({ where });
  if (!row) throw new Error('thread row missing after insert');
  return row;
}

/**
 * Store one turn. The content is checked first and replaced, never stored, when it fails.
 * Returns what was stored. The insert and the thread's `updated_at` bump are one transaction,
 * so a failure between them cannot leave a message with no bump to show for it.
 */
export async function appendMessage(
  db: Db,
  m: {
    client: string;
    threadId: string;
    runId: string | null;
    role: 'user' | 'assistant' | 'host';
    principalId: string;
    content: string;
  },
): Promise<string> {
  const content = containsRestrictedPattern(m.content) ? WITHHELD : m.content;
  await withTransaction(db, async (tx) => {
    await tx.insert(messages).values({ ...m, content });
    await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, m.threadId));
  });
  return content;
}

/**
 * The newest `limit` turns of a thread, oldest first: the shape `RunRequest.history` takes. `seq`
 * breaks a timestamp tie, so two rows one transaction wrote come back in the order they were
 * written.
 *
 * Belt and braces (spec invariant 13). The foreign key already reaches a thread that carries the
 * client, so a correct writer cannot produce a mismatch; a reader that relied on that would be one
 * join away from another tenant's rows the first time a writer was not correct. A thread id asked
 * for as somebody else is empty history, not an error.
 */
export async function recentHistory(
  db: Db,
  client: string,
  threadId: string,
  limit: number,
): Promise<RunHistoryTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.client, client), eq(messages.threadId, threadId)))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role as RunHistoryTurn['role'], content: r.content }));
}
