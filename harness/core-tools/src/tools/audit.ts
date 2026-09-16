import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { queryAuditLog } from '../domain/audit/repository.js';

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
  handler: async (args, deps) => queryAuditLog(deps, args),
});

export const auditTools: AnyToolDef[] = [auditQuery];
