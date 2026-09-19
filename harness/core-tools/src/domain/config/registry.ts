import type { ConfigSource } from '@harness/config-api';
import type { Db } from '@harness/db';
import { ConfigError, requiredEnv, type EnvSource, type Logger } from '@harness/shared';

/** The sources this build ships. A third one is a package and one line here. */
const SOURCES = ['files', 'postgres'] as const;

export interface ConfigSourceDeps {
  env: EnvSource;
  log: Logger;
  /** Only the `postgres` source uses it; the registry does not know which one will. */
  db: Db;
}

/**
 * Which source this process loads its clients from. Required, with no default.
 *
 * A default here would be a guess about a deployment's topology — a dedicated tenant on a mounted
 * volume and a pooled host on a config store are different answers — and the failure a guess
 * produces is a host that started and served nobody. Invariant 18 is the same rule from the other
 * side: the host never reads a client from the repository root, so it has to be told where one is.
 */
export function configSourceNameFrom(env: EnvSource): string {
  const name = requiredEnv('HARNESS_CONFIG_SOURCE', ` (one of: ${SOURCES.join(', ')})`, env);
  if (!(SOURCES as readonly string[]).includes(name)) {
    throw new ConfigError(`HARNESS_CONFIG_SOURCE is "${name}"; this build ships ${SOURCES.join(' and ')}`);
  }
  return name;
}

/**
 * Build the named source.
 *
 * A dynamic import, like every other plug-in loader here, so that `@harness/config-postgres`
 * costs a process that reads a directory nothing at all, and so that adding a third source is a
 * package rather than an edit to the kernel's import graph.
 */
export async function loadConfigSource(name: string, deps: ConfigSourceDeps): Promise<ConfigSource> {
  if (name === 'files') {
    const root = requiredEnv(
      'HARNESS_CLIENTS_DIR',
      ' (the directory holding one sub-directory per client; never this repository)',
      deps.env,
    );
    const { filesConfigSource } = await import('@harness/config-files');
    return filesConfigSource({ root, log: deps.log });
  }
  if (name === 'postgres') {
    const { postgresConfigSource } = await import('@harness/config-postgres');
    return postgresConfigSource({ db: deps.db, log: deps.log });
  }
  throw new ConfigError(`no config source named "${name}"; this build ships ${SOURCES.join(' and ')}`);
}
