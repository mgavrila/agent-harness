import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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

interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: { status?: string; result?: unknown };
}

function textOf(res: CallResult): string {
  return (res.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();
}

/**
 * A core-tools MCP server spawned over stdio, exactly as Hermes spawns it.
 *
 * The approvals app deliberately has no other route into the tools: executing
 * through the MCP server means the call passes the policy wrapper and lands in
 * `audit_log`, so an approved action is as traceable as an agent-initiated one.
 *
 * The child is started on first use and restarted once if the transport has
 * died, which is the common case after a `docker compose restart`.
 */
export function createMcpCoreToolsClient(launcher: McpLauncher): CoreToolsClient {
  let client: Client | null = null;

  async function connect(): Promise<Client> {
    const next = new Client({ name: 'harness-approvals', version: '0.1.0' });
    await next.connect(
      new StdioClientTransport({
        command: launcher.command,
        args: launcher.args,
        env: launcher.env,
      }),
    );
    return next;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!client) client = await connect();
    try {
      return (await client.callTool({ name, arguments: args })) as CallResult;
    } catch (err) {
      // A dead child looks like a transport error; drop it and try once more.
      console.error(
        `approvals: core-tools call ${name} failed, reconnecting: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await client.close();
      } catch {
        // already gone
      }
      client = await connect();
      return (await client.callTool({ name, arguments: args })) as CallResult;
    }
  }

  return {
    async execute(approvalId) {
      const res = await call('approvals_execute', { approval_id: approvalId });
      if (res.isError) return { status: 'failed', error: textOf(res) || 'approvals_execute returned an error' };
      const result = res.structuredContent?.result as { tool?: string } | undefined;
      return { status: 'executed', tool: result?.tool ?? 'unknown' };
    },
    async reconcile(staleAfterMinutes) {
      const res = await call('harness_reconcile', { stale_after_minutes: staleAfterMinutes });
      if (res.isError) throw new Error(textOf(res) || 'harness_reconcile returned an error');
      const result = res.structuredContent?.result as
        { approvals_expired?: number; dispatches_parked?: number } | undefined;
      return { approvals_expired: result?.approvals_expired ?? 0, dispatches_parked: result?.dispatches_parked ?? 0 };
    },
    async close() {
      if (!client) return;
      const open = client;
      client = null;
      await open.close();
    },
  };
}
