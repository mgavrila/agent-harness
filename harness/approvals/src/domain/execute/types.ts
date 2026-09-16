export type ExecuteOutcome = { status: 'executed'; tool: string } | { status: 'failed'; error: string };

export interface CoreToolsClient {
  /** Run an approved action. Never runs a handler directly: always `approvals_execute`. */
  execute(approvalId: string): Promise<ExecuteOutcome>;
  /** Expire stale approvals and park stuck dispatches, audited as a normal tool call. */
  reconcile(staleAfterMinutes: number): Promise<{ approvals_expired: number; dispatches_parked: number }>;
  close(): Promise<void>;
}

export interface McpLauncher {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: { status?: string; result?: unknown };
}
