import type { Principal } from '@harness/identity-api';
import type { CoreToolsClient, ExecuteOutcome } from './types.js';

/** A core-tools client that records calls instead of spawning an MCP server. */
export class FakeCoreToolsClient implements CoreToolsClient {
  executed: string[] = [];
  /** The id of the principal `execute` ran as, one entry per call, in order. */
  executedBy: string[] = [];
  reconciled: number[] = [];
  /** When set, `execute` reports this failure instead of succeeding. */
  failExecuteWith?: string;
  /** When set, `reconcile` throws this instead of succeeding — for exercising a tick failure. */
  failReconcileWith?: string;
  /** The tool name a successful execution reports. */
  executedTool = 'forms_release';
  closed = false;

  async execute(approvalId: string, principal: Principal): Promise<ExecuteOutcome> {
    if (this.failExecuteWith) return { status: 'failed', error: this.failExecuteWith };
    this.executed.push(approvalId);
    this.executedBy.push(principal.id);
    return { status: 'executed', tool: this.executedTool };
  }

  async reconcile(staleAfterMinutes: number): Promise<{ approvals_expired: number; dispatches_parked: number }> {
    if (this.failReconcileWith) throw new Error(this.failReconcileWith);
    this.reconciled.push(staleAfterMinutes);
    return { approvals_expired: 0, dispatches_parked: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
