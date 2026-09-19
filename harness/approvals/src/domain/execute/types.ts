import type { Principal } from '@harness/identity-api';

export type ExecuteOutcome = { status: 'executed'; tool: string } | { status: 'failed'; error: string };

export interface CoreToolsClient {
  /**
   * Run an approved action, as `principal`. Never runs a handler directly: always
   * `approvals_execute`, over a run opened for this one call.
   */
  execute(approvalId: string, principal: Principal): Promise<ExecuteOutcome>;
  /** Expire stale approvals and park stuck dispatches, audited as a normal tool call. */
  reconcile(staleAfterMinutes: number): Promise<{ approvals_expired: number; dispatches_parked: number }>;
  close(): Promise<void>;
}
