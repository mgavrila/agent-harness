import * as z from 'zod/v4';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { auditLog } from '@harness/db';
import { defineTool, type AnyToolDef } from '../registry.js';

const auditQuery = defineTool({
  name: 'audit_query',
  description: 'Query the append-only audit log of tool calls for this client. Newest first.',
  actionClass: 'read',
  input: z.object({
    tool: z.string().optional(),
    decision: z.enum(['auto', 'approval', 'blocked', 'error']).optional(),
    since: z.string().datetime().optional(),
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
        error: z.string().nullable(),
        created_at: z.string(),
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
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        action_class: r.actionClass,
        decision: r.decision,
        caller: r.caller,
        record_ids: (r.recordIds as string[]) ?? [],
        approval_id: r.approvalId,
        error: r.error,
        created_at: r.createdAt.toISOString(),
      })),
    };
  },
});

export const auditTools: AnyToolDef[] = [auditQuery];
