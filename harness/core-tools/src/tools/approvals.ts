import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { executeApproval } from '../domain/approvals/execute.js';

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
  handler: async ({ approval_id }, deps) => executeApproval(deps, approval_id),
  recordIds: ({ approval_id }) => [approval_id],
});

export const approvalTools: AnyToolDef[] = [approvalsExecute];
