import * as z from 'zod/v4';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { auditLog } from '@harness/db';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';

const auditQuery = defineTool({
  name: 'audit_query',
  description:
    'Query the append-only audit log of tool calls for this client. Newest first. ' +
    '`since` is an ISO 8601 datetime (UTC `Z` or numeric offset). ' +
    'Failures are reported as `has_error` only; the error text is not returned.',
  actionClass: 'read',
  input: z.object({
    tool: z.string().optional(),
    decision: z.enum(['auto', 'approval', 'blocked', 'error']).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        tool: z.string(),
        action_class: z.string(),
        decision: z.string(),
        caller: z.string(),
        record_ids: z.array(z.string()),
        approval_id: z.string().nullable(),
        has_error: z.boolean(),
        created_at: z.string(),
        run_id: z.string().nullable(),
        skill: z.string().nullable(),
        skill_version: z.string().nullable(),
        derived_from: z.array(z.string()),
      }),
    ),
  }),
  handler: async ({ tool, decision, since, limit }, deps) => {
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
  },
});

export const auditTools: AnyToolDef[] = [auditQuery];
