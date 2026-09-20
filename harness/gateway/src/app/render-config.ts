import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSourceNameFrom, loadConfigSource } from '@harness/core-tools';
import { createDb, type Db } from '@harness/db';
import { createLogger, requiredEnv } from '@harness/shared';
import type { ConfigSource } from '@harness/config-api';
import { renderLiteLlmConfig } from '../domain/routing/render.js';

const log = createLogger('gateway');
// harness/gateway/src/app -> harness/gateway. The target stays at the package root because
// docker-compose.yml bind-mounts `../gateway/litellm.config.yaml`: that path is part of the
// deployment, not of the source layout. Nothing here resolves a *client* from a package path.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Render one client's routing table into the LiteLLM config the Compose service mounts. */
export async function renderClientConfig(source: ConfigSource, clientId: string): Promise<string> {
  const loaded = await source.load(clientId);
  if (!loaded) throw new Error(`the ${source.name} config source holds no client "${clientId}"`);
  const target = path.join(packageRoot, 'litellm.config.yaml');
  await writeFile(target, renderLiteLlmConfig(loaded.document.routing), 'utf8');
  return target;
}

/**
 * Render the client `HARNESS_CLIENT` names, through whatever source `HARNESS_CONFIG_SOURCE` does.
 *
 * The database handle is opened on the `postgres` branch and on no other: the registry takes one
 * because the stored source needs it, and reading a document out of a mounted directory should
 * not open a connection pool to render a YAML file. The handle is closed on the failure path too,
 * so a bad routing table exits rather than hanging on an open pool.
 */
async function main(): Promise<void> {
  const clientId = requiredEnv('HARNESS_CLIENT', ' (whose routing table to render)');
  const name = configSourceNameFrom(process.env);
  const opened = name === 'postgres' ? createDb() : null;
  // The `files` branch hands the registry a handle it is typed to require and never reads.
  const db = opened?.db as Db;
  const source = await loadConfigSource(name, { env: process.env, log, db });
  try {
    const target = await renderClientConfig(source, clientId);
    console.log(`rendered ${clientId} routing to ${target}`);
  } finally {
    await source.close?.();
    await opened?.close();
  }
}

main().catch((err: unknown) => {
  // The schema exists to turn an invalid routing table into a readable listing; without this
  // the rejection went unhandled and the operator got a stack trace with the listing buried.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
