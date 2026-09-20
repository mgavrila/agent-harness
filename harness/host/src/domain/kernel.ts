import type { Client } from '@modelcontextprotocol/client';
import {
  closeRun,
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  finishRun,
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
 *
 * The run is opened first and is already `running` in the database before anything else here can
 * fail, so a throw while building the deps or connecting the in-process transport still has to
 * end it: nothing sweeps a run left open. `harness_reconcile` expires approvals and parks stuck
 * dispatches and never reads `runs`, so the only things that close a row are the turn's own
 * `finally` and the drain a shutdown runs before it stops anything. `close` is undefined until
 * `connectInProcess` actually hands one back for exactly that reason.
 */
export async function openKernel(
  host: Pick<Host, 'db' | 'config' | 'client' | 'now'>,
  run: { principal: Principal; threadId: string | null; surface: string | null; conversation: string | null },
): Promise<OpenedKernel> {
  const context = await openRun(host.db, { client: host.client, ...run });
  try {
    const deps = depsForRun(host.config, { db: host.db, principal: run.principal, context });
    const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
    return {
      client,
      deps,
      context,
      close: (status) => finishRun(host.db, host.client, context.runId, status, host.now, close),
    };
  } catch (err) {
    await closeRun(host.db, host.client, context.runId, 'error', host.now);
    throw err;
  }
}
