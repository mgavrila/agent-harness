import type { Client } from '@modelcontextprotocol/client';
import {
  closeRun,
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  openRun,
  type RunContext,
  type RunStatus,
  type ToolDeps,
} from '@harness/core-tools';
import type { Principal } from '@harness/identity-api';
import type { Host } from './host.js';

export interface OpenedKernel {
  client: Client;
  /** This run's bag. The conversation flow stamps `context.skill` on it when the runtime says so. */
  deps: ToolDeps;
  context: RunContext & { runId: string };
  close(status: RunStatus): Promise<void>;
}

/**
 * One kernel per run: a `runs` row, one `ToolDeps` on it, and an MCP client connected in-process
 * to a core-tools server built on that bag (spec decision 2). Everything the runtime calls goes
 * through `client`, and everything it calls is decided, audited and staged as this principal in
 * this run.
 */
export async function openKernel(
  host: Pick<Host, 'db' | 'config' | 'client' | 'now'>,
  run: { principal: Principal; threadId: string | null; surface: string | null; conversation: string | null },
): Promise<OpenedKernel> {
  const context = await openRun(host.db, { client: host.client, ...run });
  const deps = depsForRun(host.config, { db: host.db, principal: run.principal, context });
  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
  return {
    client,
    deps,
    context,
    close: async (status) => {
      await close();
      await closeRun(host.db, context.runId, status, host.now);
    },
  };
}
