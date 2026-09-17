import type { Client } from '@modelcontextprotocol/client';
import {
  closeRun,
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  openRun,
  type KernelConfig,
} from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { describeError } from '@harness/shared';
import type { CallResult, CoreToolsClient, ExecuteOutcome } from './types.js';

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
    const deps = depsForRun(opts.config, { db: opts.db, principal, context });
    const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
    let status: 'done' | 'error' = 'done';
    try {
      return await fn(client);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      await close();
      await closeRun(opts.db, context.runId, status, now);
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
