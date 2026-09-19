import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createLogger } from '@harness/shared';
import { createCoreToolsServer } from '../tools/catalog.js';
import { assertEmbedDims } from '../domain/knowledge/embed.js';
import { reconcile } from '../domain/tooling/reconcile.js';
import { writeAudit, hashArgs } from '../domain/tooling/audit.js';
import { buildDepsFromEnv } from './server.js';

const log = createLogger('core-tools');

// The repository root .env, resolved from this file rather than from the
// process working directory, which is whatever launched the MCP server.
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'), quiet: true });

const { deps, close } = await buildDepsFromEnv();

// Before anything is served: a deployment whose HARNESS_EMBED_DIMS does not match the column
// would fail on the first knowledge write, halfway through a sync, with rows already inserted.
await assertEmbedDims(deps.db, deps.embedDims);

try {
  const repaired = await reconcile(deps.db, { now: deps.now, client: deps.client });
  log.info(`reconcile on startup for ${deps.client}: ${JSON.stringify(repaired)}`);
  // A startup repair changes rows nobody asked it to change, so it leaves a
  // trace. Only when it actually repaired something: a no-op start would
  // otherwise write a row on every process launch.
  if (repaired.approvals_expired > 0 || repaired.dispatches_parked > 0) {
    await writeAudit(deps.db, {
      client: deps.client,
      caller: deps.principal.id,
      tool: 'harness_reconcile',
      actionClass: 'write.internal',
      argsHash: hashArgs({ startup: true }),
      decision: 'auto',
      recordIds: [],
    });
  }
} catch (err) {
  log.warn('reconcile at startup failed; continuing', err);
}

serveStdio(() => createCoreToolsServer(deps));
log.info(`listening on stdio (client=${deps.client}, principal=${deps.principal.id}, run=${deps.context.runId})`);

async function shutdown(signal: string): Promise<void> {
  try {
    await close();
    process.exit(0);
  } catch (err) {
    log.error(`shutdown after ${signal} failed`, err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
