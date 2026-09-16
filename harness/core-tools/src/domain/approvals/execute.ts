import { and, eq, gt } from 'drizzle-orm';
import { approvals, auditLog, decrypt } from '@harness/db';
import { ToolError } from '@harness/shared';
import { auditBaseFor, withCurrentTool } from '../tooling/context.js';
import { hashArgs, writeAudit } from '../tooling/audit.js';
import { decide } from '../tooling/policy.js';
import type { ToolDeps } from '../tooling/types.js';

export interface ExecutedApproval {
  approval_id: string;
  tool: string;
  status: 'executed';
  result: unknown;
}

/**
 * Run an action a human approved. Succeeds at most once per approval: the row must be
 * approved and unexpired, and it becomes `executed` in the same transaction as the action, so
 * a failed action leaves the row approved and retryable.
 *
 * `deps.db` is already the registry's transaction, and the guarded UPDATE below locks the row.
 */
export async function executeApproval(deps: ToolDeps, approvalId: string): Promise<ExecutedApproval> {
  const [row] = await deps.db
    .update(approvals)
    .set({ status: 'executed', executedAt: deps.now() })
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.client, deps.client),
        eq(approvals.status, 'approved'),
        gt(approvals.expiresAt, deps.now()),
      ),
    )
    .returning();
  if (!row) throw new ToolError(`approval ${approvalId} is not executable: it must be approved and unexpired`);
  if (!row.payloadEncrypted) throw new ToolError(`approval ${approvalId} has no executable payload`);

  const parsed = JSON.parse(decrypt(row.payloadEncrypted, deps.encryptionKey)) as {
    tool: string;
    args: Record<string, unknown>;
  };
  const target = deps.tools.get(parsed.tool);
  if (!target) throw new ToolError(`approval ${approvalId} references unknown tool ${parsed.tool}`);
  // Policy is re-read at replay time: an approval granted before the class
  // was blocked must not become a way around the current policy. Throwing
  // here rolls the `executed` transition back to `approved`.
  if (decide(target.actionClass, deps.policy) === 'blocked') {
    throw new ToolError(`approval ${approvalId} cannot execute: ${target.name} is now blocked by policy`);
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
  return { approval_id: row.id, tool: target.name, status: 'executed', result };
}
