import type { Client } from '@modelcontextprotocol/client';
import {
  closeRun,
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  openRun,
  sumRunTotals,
  type RunContext,
  type RunStatus,
  type ToolDeps,
} from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { createLogger } from '@harness/shared';
import type { Host } from './host.js';

const log = createLogger('host');

export interface OpenedKernel {
  client: Client;
  /** This run's bag. The conversation flow stamps `context.skill` on it when the runtime says so. */
  deps: ToolDeps;
  context: RunContext & { runId: string };
  close(status: RunStatus): Promise<void>;
}

/**
 * Close the in-process transport, then close the run with what it spent — in that order, but
 * never let the first step's failure skip the second. A `close()` that itself rejects (the client
 * or its handler failing to tear down cleanly) is logged and swallowed rather than thrown,
 * because the run ending with the call's real status matters more than a clean transport
 * shutdown, and a throw here would otherwise skip `closeRun` entirely. Exported so this guarantee
 * is directly testable without needing the real transport to misbehave.
 *
 * The totals are read after the transport is closed, so a tool call still in flight when the run
 * ends has written its row by the time they are summed. `usage_runs` reads `runs` alone for its
 * tokens, which is why they are summed from the run's own `model_calls` rows here rather than
 * counted in memory by the turn: `sumRunTotals` is the one place they are computed.
 */
export async function finishKernel(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (err) {
    log.error(`could not close the in-process core-tools client for run ${runId}`, err);
  }
  await closeRun(db, client, runId, status, now, await sumRunTotals(db, client, runId));
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
      close: (status) => finishKernel(host.db, host.client, context.runId, status, host.now, close),
    };
  } catch (err) {
    await closeRun(host.db, host.client, context.runId, 'error', host.now);
    throw err;
  }
}
