import { createDb } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { ConfigError, createLogger, envOrDefault } from '@harness/shared';
import { loadIdentity } from '../domain/identity/registry.js';
import { buildKernelConfig, clientDirFor } from '../domain/tooling/config.js';
import { depsForRun, type KernelConfig } from '../domain/tooling/deps.js';
import type { ToolDeps } from '../domain/tooling/types.js';
import { openRun } from '../domain/session/repository.js';

const log = createLogger('core-tools');

/** Re-exported so `buildKernelConfig` and this module name the client folder the one way. */
export { clientDirFor };

/**
 * The principal this process acts as: `HARNESS_PRINCIPAL`, an id the identity plug-in
 * `HARNESS_IDENTITY` names must declare. The plug-in is connected for this one lookup and
 * stopped again — a stdio server is one principal for its whole life, so it keeps no session.
 * An undeclared id is a startup failure: a server that started anyway would audit every call
 * as somebody nobody vouched for.
 */
export async function resolvePrincipal(config: Pick<KernelConfig, 'client' | 'env'>): Promise<Principal> {
  const specifier = envOrDefault('HARNESS_IDENTITY', '@harness/identity-static');
  const session = await loadIdentity(specifier, { env: config.env, log, clientDir: clientDirFor(config.client) });
  try {
    const id = envOrDefault('HARNESS_PRINCIPAL', 'svc-local');
    const principal = await session.get(id);
    if (!principal) {
      throw new ConfigError(
        `HARNESS_PRINCIPAL names "${id}", which the identity plug-in "${session.name}" does not declare`,
      );
    }
    return principal;
  } finally {
    await session.stop();
  }
}

/**
 * The stdio server's dependencies: the shared configuration, this process's principal, and one
 * run for the process's lifetime. A multi-run host builds its own `KernelConfig` once and calls
 * `openRun` and `depsForRun` per run instead.
 */
export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const config = await buildKernelConfig(process.env);
  const principal = await resolvePrincipal(config);
  const context = await openRun(db, { client: config.client, principal });
  return { deps: depsForRun(config, { db, principal, context }), close };
}
