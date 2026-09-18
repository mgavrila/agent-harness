import { and, desc, eq, or, sql } from 'drizzle-orm';
import { messages, threads } from '@harness/db';
import { levelAtLeast } from '@harness/identity-api';
import type { ToolDeps } from '../tooling/types.js';
import { SESSION_SEARCH_LIMIT, type SessionHit } from './types.js';

/**
 * Episodic recall (spec 5.5): full-text search over the `messages` of the threads the caller
 * took part in, plus every playbook thread for a lead and above.
 *
 * The visibility filter is in the WHERE clause and the ranking in the ORDER BY, so a row the
 * caller may not see is never ranked (invariant 7). `plainto_tsquery` takes the query as plain
 * words — no operators, so nothing the model writes can widen the match — and a query of stop
 * words alone is the empty query, which matches nothing. The snippet is `ts_headline` with
 * empty selectors: the matching window as plain text, from content that already passed the
 * redaction guard when it was stored.
 */
export async function searchSessions(
  deps: ToolDeps,
  args: { query: string; limit: number },
): Promise<{ hits: SessionHit[] }> {
  const query = sql`plainto_tsquery('english', ${args.query})`;
  const rank = sql<number>`ts_rank(${messages.tsv}, ${query})`;
  const own = eq(threads.principalId, deps.principal.id);
  const visible = levelAtLeast(deps.principal.level, 'lead') ? or(own, eq(threads.kind, 'playbook')) : own;
  const rows = await deps.db
    .select({
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      role: messages.role,
      snippet: sql<string>`ts_headline('english', ${messages.content}, ${query}, 'MaxWords=25, MinWords=10, StartSel="", StopSel=""')`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(threads.client, deps.client), visible, sql`${messages.tsv} @@ ${query}`))
    .orderBy(desc(rank), desc(messages.createdAt), desc(messages.seq))
    .limit(Math.min(args.limit, SESSION_SEARCH_LIMIT));
  return {
    hits: rows.map((r) => ({
      thread_id: r.threadId,
      created_at: r.createdAt.toISOString(),
      role: r.role,
      snippet: r.snippet,
    })),
  };
}
