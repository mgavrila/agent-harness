import { resolveSecrets, type ClientDocument } from '@harness/config-api';
import { createDb } from '@harness/db';
import { parseIdentityFileWithDefaults, type Principal } from '@harness/identity-api';
import { ConfigError, createLogger, envOrDefault } from '@harness/shared';
import { loadClientDocument, loadSecretSource, secretSourceNameFrom } from '../domain/config/registry.js';
import { loadIdentity } from '../domain/identity/registry.js';
import { buildKernelConfig } from '../domain/tooling/config.js';
import { depsForRun } from '../domain/tooling/deps.js';
import type { ToolDeps } from '../domain/tooling/types.js';
import { openRun } from '../domain/session/repository.js';

const log = createLogger('core-tools');

/**
 * The principal this process acts as: `HARNESS_PRINCIPAL`, an id the client document's identity
 * section must declare. The plug-in is connected for this one lookup and stopped again — a stdio
 * server is one principal for its whole life, so it keeps no session. An undeclared id is a
 * startup failure: a server that started anyway would audit every call as somebody nobody
 * vouched for.
 */
export async function resolvePrincipal(document: ClientDocument, env: NodeJS.ProcessEnv): Promise<Principal> {
  const session = await loadIdentity(`@harness/identity-${document.identityPlugin.kind}`, {
    env,
    log,
    identity: parseIdentityFileWithDefaults(document.identity),
    settings: document.identityPlugin.settings,
    // A stdio server connects no surface, so there is no directory to offer. A document whose
    // plug-in needs one fails here, naming the surface, rather than resolving nobody.
    directories: {},
  });
  try {
    const id = envOrDefault('HARNESS_PRINCIPAL', 'svc-local', env);
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
 * The stdio server's dependencies: this client's document, the configuration it implies, this
 * process's principal, and one run for the process's lifetime. A multi-run host builds its own
 * `KernelConfig` per tenant and calls `openRun` and `depsForRun` per run instead.
 */
export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const document = await loadClientDocument({ env: process.env, log, db });
  // The stdio server has one client for its whole life, so it resolves that client's secrets once
  // and lets the source go: a process that serves one client has nothing to watch, and a source
  // left open would hold a connection for the life of the process for no reader — the same
  // reasoning `loadClientDocument` already applies to the config source.
  const source = await loadSecretSource(secretSourceNameFrom(process.env), { env: process.env, log, db });
  const secrets = await resolveSecrets(document, { source, log }).finally(() => source.close?.());
  const config = await buildKernelConfig(document, process.env, secrets);
  const principal = await resolvePrincipal(document, process.env);
  const context = await openRun(db, { client: config.client, principal });
  return { deps: depsForRun(config, { db, principal, context }), close };
}
