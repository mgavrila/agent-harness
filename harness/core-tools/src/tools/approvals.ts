import * as z from 'zod/v4';
import { and, eq, gt } from 'drizzle-orm';
import { approvals, decrypt } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef, type ToolDeps } from '../registry.js';
import { writeAudit, hashArgs } from '../audit.js';

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

    const parsed = JSON.parse(decrypt(row.payloadEncrypted, deps.encryptionKey)) as { tool: string; args: Record<string, unknown> };
    const target = deps.tools.get(parsed.tool);
    if (!target) throw new ToolError(`approval ${approval_id} references unknown tool ${parsed.tool}`);

    const args = target.input.parse(parsed.args) as Record<string, unknown>;
    const targetDeps: ToolDeps = { ...deps, context: deps.context };
    const previousTool = deps.context.tool;
    deps.context.tool = target.name;
    let result: unknown;
    try {
      result = await target.handler(args, targetDeps);
    } finally {
      deps.context.tool = previousTool;
    }
    await writeAudit(deps.db, {
      client: deps.client,
      caller: deps.caller,
      tool: target.name,
      actionClass: target.actionClass,
      argsHash: hashArgs(args),
      decision: 'auto',
      approvalId: row.id,
      recordIds: target.recordIds?.(args, result) ?? [],
      runId: deps.context.runId ?? null,
      skill: deps.context.skill ?? null,
      skillVersion: deps.context.skillVersion ?? null,
    });
    return { approval_id: row.id, tool: target.name, status: 'executed' as const, result };
  },
  recordIds: ({ approval_id }) => [approval_id],
});

export const approvalTools: AnyToolDef[] = [approvalsExecute];
