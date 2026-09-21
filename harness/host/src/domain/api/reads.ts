import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { approvals, memoryEntries, type Db } from '@harness/db';

/**
 * What the platform's control plane reads, per tenant, for a dashboard and a memory page.
 *
 * Two routes with **identical authentication and tenant resolution** to `/v1/usage` — the bearer,
 * then `x-harness-client` through the pool's resolver — and no principal resolution at all: the
 * caller is the control plane acting for the tenant, not a person acting as themselves. That is
 * why the column lists below are the whole of the guarantee, and why a test asserts each one
 * whole (invariant 23).
 *
 * Snake case, because this is what goes on the wire, exactly as `UsageRow` is.
 */

/** The four values the `approvals.status` column is ever written with, and nothing else. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'declined', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The two scopes a memory entry has. */
export const MEMORY_SCOPES = ['principal', 'client'] as const;

/** How many rows one page holds when a caller names no limit, and the most it may ask for. */
export const READ_DEFAULT_LIMIT = 100;
export const READ_MAX_LIMIT = 500;

export interface Page<T> {
  rows: T[];
  /** The cursor for the next page, or null at the end. */
  next_cursor: string | null;
}

/**
 * One approval of this tenant.
 *
 * `payload` and `payload_encrypted` are the tool's own arguments and are **excluded** — invariant
 * 16's rule applied to an export it did not name, which invariant 23 makes explicit.
 * `idempotency_key`, `message_ref`, `thread_id` and `claimed_at` are the poller's bookkeeping and
 * are excluded too.
 */
export interface ApprovalReadRow {
  id: string;
  action: string;
  summary: string;
  requested_by: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  expires_at: string;
  surface: string | null;
  conversation_id: string | null;
  created_at: string;
}

/**
 * One memory entry of this tenant.
 *
 * `text` is included, because that is the entry — a memory page with no memories is not a page —
 * and because `memory_list` returns exactly this to the model already. `principal_id` is
 * included, which `memory_list`'s own entry shape omits: a tool's caller *is* the principal, and
 * a tenant-scoped export has no such excuse. An id is an id rather than content, so invariant 16
 * does not reach it. `thread_id` is excluded; it is a join key.
 */
export interface MemoryReadRow {
  id: string;
  scope: string;
  principal_id: string | null;
  text: string;
  created_by: string;
  created_at: string;
}

/**
 * The sort key of the last row a page returned, as one opaque string.
 *
 * `(created_at, id)` in that route's own direction, so it is stable under insertion and carries
 * no offset: a row written between two reads lands where its own key puts it and moves no page.
 * base64url, because it travels in a query string.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** The other direction, or null for anything that is not one of ours. */
export function decodeCursor(raw: string): { at: Date; id: string } | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) return null;
  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id === '') return null;
  return { at, id };
}

/** `limit + 1` rows, so a page knows whether there is another without counting the table. */
const overRead = (limit: number): number => limit + 1;

function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => { at: Date; id: string }): Page<T> {
  if (rows.length <= limit) return { rows, next_cursor: null };
  const page = rows.slice(0, limit);
  const last = keyOf(page[page.length - 1]);
  return { rows: page, next_cursor: encodeCursor(last.at, last.id) };
}

export interface ReadApprovalsOptions {
  client: string;
  statuses?: readonly string[];
  cursor?: string | null;
  limit: number;
}

/** One page of this tenant's approvals, newest first. */
export async function readApprovals(db: Db, opts: ReadApprovalsOptions): Promise<Page<ApprovalReadRow>> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db
    .select({
      id: approvals.id,
      action: approvals.action,
      summary: approvals.summary,
      requestedBy: approvals.requestedBy,
      status: approvals.status,
      decidedBy: approvals.decidedBy,
      decidedAt: approvals.decidedAt,
      decisionNote: approvals.decisionNote,
      executedAt: approvals.executedAt,
      expiresAt: approvals.expiresAt,
      surface: approvals.surface,
      conversationId: approvals.conversationId,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(
      and(
        // The tenant predicate, and there is no way to widen it: the client is the one the request
        // resolved to, never one the caller asked for.
        eq(approvals.client, opts.client),
        opts.statuses && opts.statuses.length > 0 ? inArray(approvals.status, [...opts.statuses]) : undefined,
        // A row comparison, so the pair is compared as one key rather than as two predicates —
        // which is what makes a page stable when two rows share a timestamp. The right side reads
        // the anchor's own stored value, not `after.at` directly: `created_at` came back through
        // this driver's timestamp parser, which only keeps millisecond precision, while `now()`
        // (what the column defaults to) carries microseconds. Comparing against the row's own
        // stored value sidesteps that loss; comparing against the floored `after.at` instead can
        // both hand back the anchor row again and drop a genuinely older row that shares its
        // floored millisecond. `client` is repeated in the subquery so an id from another tenant
        // can't be used to probe this one's timestamps, even though the outer query is already
        // scoped. The `COALESCE` is for a row a retention job deleted between two reads: with
        // nothing left to look up, this falls back to the cursor's own (still usable) values
        // rather than an empty subquery result, which would otherwise make every later row vanish
        // along with the anchor and the page look finished when it is not.
        after
          ? sql`(${approvals.createdAt}, ${approvals.id}) < (
              COALESCE((SELECT created_at FROM approvals WHERE id = ${after.id} AND client = ${opts.client}), ${after.at}),
              COALESCE((SELECT id FROM approvals WHERE id = ${after.id} AND client = ${opts.client}), ${after.id})
            )`
          : undefined,
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(overRead(opts.limit));
  const mapped: ApprovalReadRow[] = rows.map((row) => ({
    id: row.id,
    action: row.action,
    summary: row.summary,
    requested_by: row.requestedBy,
    status: row.status,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_note: row.decisionNote,
    executed_at: row.executedAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    surface: row.surface,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
  }));
  return pageOf(mapped, opts.limit, (row) => ({ at: new Date(row.created_at), id: row.id }));
}

export interface ReadMemoryOptions {
  client: string;
  scope?: string;
  principal?: string;
  cursor?: string | null;
  limit: number;
}

/**
 * One page of this tenant's memory entries, **oldest first** — the order `listMemory` already
 * uses, so a page of this export and a page the model was shown read the same way round.
 */
export async function readMemory(db: Db, opts: ReadMemoryOptions): Promise<Page<MemoryReadRow>> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db
    .select({
      id: memoryEntries.id,
      scope: memoryEntries.scope,
      principalId: memoryEntries.principalId,
      text: memoryEntries.text,
      createdBy: memoryEntries.createdBy,
      createdAt: memoryEntries.createdAt,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.client, opts.client),
        opts.scope ? eq(memoryEntries.scope, opts.scope) : undefined,
        opts.principal ? eq(memoryEntries.principalId, opts.principal) : undefined,
        // See `readApprovals`: the subquery compares against the anchor's own stored value rather
        // than the millisecond-floored `after.at`, so a row that shares the anchor's floored
        // millisecond is neither handed back a second time nor skipped; `client` keeps the lookup
        // inside this tenant; `COALESCE` falls back to the cursor's own values when the anchor row
        // is gone, so a deleted anchor never makes the rest of the page vanish with it.
        after
          ? sql`(${memoryEntries.createdAt}, ${memoryEntries.id}) > (
              COALESCE((SELECT created_at FROM memory_entries WHERE id = ${after.id} AND client = ${opts.client}), ${after.at}),
              COALESCE((SELECT id FROM memory_entries WHERE id = ${after.id} AND client = ${opts.client}), ${after.id})
            )`
          : undefined,
      ),
    )
    .orderBy(asc(memoryEntries.createdAt), asc(memoryEntries.id))
    .limit(overRead(opts.limit));
  const mapped: MemoryReadRow[] = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    principal_id: row.principalId,
    text: row.text,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  }));
  return pageOf(mapped, opts.limit, (row) => ({ at: new Date(row.created_at), id: row.id }));
}
