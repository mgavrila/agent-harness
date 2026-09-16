import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { auditLog } from '@harness/db';
import type { ToolDeps } from '../tooling/types.js';

/** The filters `audit_query` accepts, already parsed by its input schema. */
export interface AuditQueryArgs {
  tool?: string;
  decision?: string;
  /** ISO 8601 datetime; rows older than it are left out. */
  since?: string;
  limit: number;
}

export interface AuditEntry {
  id: string;
  tool: string;
  action_class: string;
  decision: string;
  caller: string;
  record_ids: string[];
  approval_id: string | null;
  has_error: boolean;
  created_at: string;
  run_id: string | null;
  skill: string | null;
  skill_version: string | null;
  derived_from: string[];
}

/** `audit_query`: this client's audit rows, newest first, at most `limit`. */
export async function queryAuditLog(
  deps: ToolDeps,
  { tool, decision, since, limit }: AuditQueryArgs,
): Promise<{ entries: AuditEntry[] }> {
  const conditions: SQL[] = [eq(auditLog.client, deps.client)];
  if (tool) conditions.push(eq(auditLog.tool, tool));
  if (decision) conditions.push(eq(auditLog.decision, decision));
  if (since) conditions.push(gte(auditLog.createdAt, new Date(since)));
  const rows = await deps.db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
  return {
    entries: rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      action_class: r.actionClass,
      decision: r.decision,
      caller: r.caller,
      record_ids: r.recordIds,
      approval_id: r.approvalId,
      // The error text itself stays in the database: it can carry record
      // identifiers or restricted values, so operators read it with psql.
      has_error: r.error !== null,
      created_at: r.createdAt.toISOString(),
      run_id: r.runId,
      skill: r.skill,
      skill_version: r.skillVersion,
      derived_from: r.derivedFrom,
    })),
  };
}
