import * as z from 'zod/v4';
import { and, eq, gt } from 'drizzle-orm';
import { approvals, auditLog, decrypt } from '@harness/db';
import { auditBaseFor, defineTool, ToolError, withCurrentTool, type AnyToolDef } from '../registry.js';
import { writeAudit, hashArgs } from '../audit.js';
import { decide } from '../policy.js';

const approvalsExecute = defineTool({
  name: 'approvals_execute',
  description:
    'Run an action that a human has approved. Succeeds at most once per approval: the row must be approved and ' +
    'unexpired, and it becomes executed in the same transaction as the action. A failed action leaves the row approved.',
  actionClass: 'write.internal',
  input: z.object({ approval_id: z.string().uuid() }),
  output: z.object({
    approval_id: z.string(),
    tool: z.string(),
    status: z.literal('executed'),
    result: z.unknown(),
  }),
  handler: async ({ approval_id }, deps) => {
    // deps.db is already the registry's transaction; the UPDATE below locks the
    // row, and a thrown error rolls the transition back with the handler's writes.
    const [row] = await deps.db
      .update(approvals)
      .set({ status: 'executed', executedAt: deps.now() })
      .where(
        and(
          eq(approvals.id, approval_id),
          eq(approvals.client, deps.client),
          eq(approvals.status, 'approved'),
          gt(approvals.expiresAt, deps.now()),
        ),
      )
      .returning();
    if (!row) throw new ToolError(`approval ${approval_id} is not executable: it must be approved and unexpired`);
    if (!row.payloadEncrypted) throw new ToolError(`approval ${approval_id} has no executable payload`);

    const parsed = JSON.parse(decrypt(row.payloadEncrypted, deps.encryptionKey)) as {
      tool: string;
      args: Record<string, unknown>;
    };
    const target = deps.tools.get(parsed.tool);
    if (!target) throw new ToolError(`approval ${approval_id} references unknown tool ${parsed.tool}`);
    // Policy is re-read at replay time: an approval granted before the class
    // was blocked must not become a way around the current policy. Throwing
    // here rolls the `executed` transition back to `approved`.
    if (decide(target.actionClass, deps.policy) === 'blocked') {
      throw new ToolError(`approval ${approval_id} cannot execute: ${target.name} is now blocked by policy`);
    }

    const args = target.input.parse(parsed.args) as Record<string, unknown>;
    // The replayed tool runs on this handler's deps, so it shares the open
    // transaction and the session context.
    const result: unknown = await withCurrentTool(deps.context, target.name, () => target.handler(args, deps));
    // The replay continues the chain the parked call started, so it inherits
    // that call's lineage rather than starting a fresh, empty one.
    const parking = await deps.db.query.auditLog.findFirst({
      where: and(eq(auditLog.approvalId, row.id), eq(auditLog.decision, 'approval')),
    });
    await writeAudit(deps.db, {
      ...auditBaseFor(deps, target, hashArgs(args), parking?.derivedFrom ?? []),
      decision: 'auto',
      approvalId: row.id,
      recordIds: target.recordIds?.(args, result) ?? [],
    });
    return { approval_id: row.id, tool: target.name, status: 'executed' as const, result };
  },
  recordIds: ({ approval_id }) => [approval_id],
});

export const approvalTools: AnyToolDef[] = [approvalsExecute];
