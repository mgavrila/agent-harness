import type { ClientDocument, ConfigSource } from '@harness/config-api';
import type { Db } from '@harness/db';
import { ConfigError, envOrDefault, requiredEnv, type EnvSource, type Logger } from '@harness/shared';

/** The sources this build ships. A third one is a package and one line here. */
const SOURCES = ['files', 'postgres'] as const;

export interface ConfigSourceDeps {
  env: EnvSource;
  log: Logger;
  /**
   * Only the `postgres` source uses it, so a caller that has already decided it is naming a
   * directory may leave it out rather than open a connection pool to read a YAML file — and one
   * that cannot know which source it will get passes the handle it has.
   */
  db?: Db;
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
    if (!deps.db) throw new ConfigError('the postgres config source reads its documents from a database; open one');
    const { postgresConfigSource } = await import('@harness/config-postgres');
    return postgresConfigSource({ db: deps.db, log: deps.log });
  }
  throw new ConfigError(`no config source named "${name}"; this build ships ${SOURCES.join(' and ')}`);
}

/**
 * The one client the stdio server serves, resolved through whatever `HARNESS_CONFIG_SOURCE` names.
 *
 * `HARNESS_CLIENT` is required here, with no default, and an empty value is refused: this process
 * is one client for its whole life and a default would be a guess at which one. The host reads the
 * same variable and reads it differently — unset *or* empty is a pooled host there, because
 * Compose passes the variable through empty when it is unset — and that is the difference between
 * a process that can serve many clients and one that cannot. A client the source does not hold is
 * a startup failure naming both the id and the source, because a process that started anyway would
 * serve a client nobody configured.
 *
 * The source is opened for this one read and closed again, on the failure path too: a process
 * that serves one client has nothing to watch, and a source left open would hold a connection or
 * a file watcher for the life of the process for no reader.
 */
export async function loadClientDocument(deps: ConfigSourceDeps): Promise<ClientDocument> {
  const clientId = envOrDefault('HARNESS_CLIENT', '', deps.env);
  if (clientId === '') {
    throw new ConfigError('HARNESS_CLIENT names the one client this stdio server serves; set it to a client id');
  }
  const source = await loadConfigSource(configSourceNameFrom(deps.env), deps);
  try {
    const loaded = await source.load(clientId);
    if (!loaded) throw new ConfigError(`the ${source.name} config source holds no client "${clientId}"`);
    return loaded.document;
  } finally {
    await source.close?.();
  }
}
