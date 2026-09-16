import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildDepsFromEnv, createCoreToolsServer } from './server.js';
import { reconcile } from './domain/tooling/reconcile.js';
import { writeAudit, hashArgs } from './domain/tooling/audit.js';

// The repository root .env, resolved from this file rather than from the
// process working directory, which is whatever launched the MCP server.
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

const { deps, close } = await buildDepsFromEnv();

try {
  const repaired = await reconcile(deps.db, { now: deps.now });
  console.error(`core-tools: reconcile on startup: ${JSON.stringify(repaired)}`);
  // A startup repair changes rows nobody asked it to change, so it leaves a
  // trace. Only when it actually repaired something: a no-op start would
  // otherwise write a row on every process launch.
  if (repaired.approvals_expired > 0 || repaired.dispatches_parked > 0) {
    await writeAudit(deps.db, {
      client: deps.client,
      caller: 'startup',
      tool: 'harness_reconcile',
      actionClass: 'write.internal',
      argsHash: hashArgs({ startup: true }),
      decision: 'auto',
      recordIds: [],
    });
  }
} catch (err) {
  console.error(
    `core-tools: reconcile at startup failed: ${err instanceof Error ? err.message : String(err)}; continuing`,
  );
}

serveStdio(() => createCoreToolsServer(deps));
console.error(`core-tools listening on stdio (client=${deps.client}, caller=${deps.caller})`);

async function shutdown(signal: string): Promise<void> {
  try {
    await close();
    process.exit(0);
  } catch (err) {
    console.error(`core-tools: shutdown after ${signal} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
