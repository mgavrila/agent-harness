import type { Client } from '@modelcontextprotocol/client';
import {
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  finishRun,
  openRun,
  type KernelConfig,
} from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { describeError } from '@harness/shared';
import type { CoreToolsClient, ExecuteOutcome } from './types.js';

/** The slice of an MCP `callTool` response the two calls below read. */
interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: { status?: string; result?: unknown };
}

export interface InProcessCoreToolsOptions {
  db: Db;
  config: KernelConfig;
  client: string;
  /** Whose runs the housekeeping calls are: the host's own service principal. */
  servicePrincipal: Principal;
  now?: () => Date;
}

function textOf(res: CallResult): string {
  return (res.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();
}

/**
 * The kernel, hosted in this process, one run per call.
 *
 * Every call opens a `runs` row as the given principal, builds one `ToolDeps` for it, connects an
 * MCP client to a server on that bag, makes the one call, and closes the run — so an approved
 * action executes and is audited as the person who approved it, and a reconcile as the host's own
 * service identity. Still through the MCP server, never a handler directly: the call passes the
 * policy switch and lands in `audit_log` like an agent-initiated one.
 */
export function createInProcessCoreToolsClient(opts: InProcessCoreToolsOptions): CoreToolsClient {
  const now = opts.now ?? (() => new Date());

  async function withRun<T>(principal: Principal, fn: (client: Client) => Promise<T>): Promise<T> {
    const context = await openRun(opts.db, { client: opts.client, principal });
    let status: 'done' | 'error' = 'done';
    // Undefined until `connectInProcess` actually hands one back: if building the server or
    // connecting the client throws, there is nothing to close, but the run — already open —
    // still has to end, which is why this is armed before the try rather than the source of it.
    let close: (() => Promise<void>) | undefined;
    try {
      const deps = depsForRun(opts.config, { db: opts.db, principal, context });
      const connected = await connectInProcess(() => createCoreToolsServer(deps));
      close = connected.close;
      return await fn(connected.client);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      await finishRun(opts.db, opts.client, context.runId, status, now, close ?? (() => Promise.resolve()));
    }
  }

  return {
    execute: (approvalId, principal) =>
      withRun(principal, async (client) => {
        const res = (await client.callTool({
          name: 'approvals_execute',
          arguments: { approval_id: approvalId },
        })) as CallResult;
        if (res.isError)
          return {
            status: 'failed',
            error: textOf(res) || 'approvals_execute returned an error',
          } satisfies ExecuteOutcome;
        const result = res.structuredContent?.result as { tool?: string } | undefined;
        return { status: 'executed', tool: result?.tool ?? 'unknown' } satisfies ExecuteOutcome;
      }).catch((err: unknown) => ({ status: 'failed', error: describeError(err) }) satisfies ExecuteOutcome),
    reconcile: (staleAfterMinutes) =>
      withRun(opts.servicePrincipal, async (client) => {
        const res = (await client.callTool({
          name: 'harness_reconcile',
          arguments: { stale_after_minutes: staleAfterMinutes },
        })) as CallResult;
        if (res.isError) throw new Error(textOf(res) || 'harness_reconcile returned an error');
        const result = res.structuredContent?.result as
          { approvals_expired?: number; dispatches_parked?: number } | undefined;
        return { approvals_expired: result?.approvals_expired ?? 0, dispatches_parked: result?.dispatches_parked ?? 0 };
      }),
    close: async () => {},
  };
}
