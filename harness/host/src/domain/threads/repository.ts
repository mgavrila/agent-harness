import { and, desc, eq } from 'drizzle-orm';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { messages, threads, type Db } from '@harness/db';
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

/** Store one turn. The content is checked first and replaced, never stored, when it fails. Returns what was stored. */
export async function appendMessage(
  db: Db,
  m: {
    threadId: string;
    runId: string | null;
    role: 'user' | 'assistant' | 'host';
    principalId: string;
    content: string;
  },
): Promise<string> {
  const content = containsRestrictedPattern(m.content) ? WITHHELD : m.content;
  await db.insert(messages).values({ ...m, content });
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, m.threadId));
  return content;
}

/** The newest `limit` turns of a thread, oldest first: the shape `RunRequest.history` takes. */
export async function recentHistory(db: Db, threadId: string, limit: number): Promise<RunHistoryTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role as RunHistoryTurn['role'], content: r.content }));
}
