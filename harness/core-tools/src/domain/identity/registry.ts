import type { IdentityDeps, IdentityModule, IdentitySession } from '@harness/identity-api';
import { ConfigError, createLogger } from '@harness/shared';

const log = createLogger('identity');

/**
 * How importing and connecting both report a plug-in that will not load. A `ConfigError` is
 * safe by construction and names what the operator got wrong, so it is re-raised with the
 * specifier in front; anything else may carry a path or a token, so it is logged in full and
 * replaced with a message naming only the plug-in.
 */
function pluginFailed(specifier: string, err: unknown, stage: 'initialise' | 'connect'): never {
  if (err instanceof ConfigError) throw new ConfigError(`identity plug-in "${specifier}": ${err.message}`);
  log.error(`identity plug-in "${specifier}" failed to ${stage}`, err);
  throw new ConfigError(`identity plug-in "${specifier}" failed to ${stage}`);
}

/**
 * Load and connect the identity plug-in the client document names.
 *
 * The specifier is derived from a name, so this is the one place in core-tools that reaches a
 * plug-in at all, and it reaches it the way `loadPacks` reaches a pack: by name, at startup, with no
 * build-time edge. `pnpm arch` forbids a static `identities/*` import anywhere else under `src/`.
 * The three failure modes are told apart the same way, so an operator who has debugged one has
 * debugged all three: an unresolvable specifier is replaced, because the resolver's own message
 * carries absolute paths and a node_modules layout that does not belong in a container log; the
 * other two go through `pluginFailed`.
 */
export async function loadIdentity(specifier: string, deps: IdentityDeps): Promise<IdentitySession> {
  let module: Partial<IdentityModule>;
  try {
    module = (await import(specifier)) as Partial<IdentityModule>;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new ConfigError(
        `cannot load identity plug-in "${specifier}"; add it to @harness/core-tools dependencies and run pnpm install`,
      );
    }
    pluginFailed(specifier, err, 'initialise');
  }
  if (!module.identity) throw new ConfigError(`module "${specifier}" exports no \`identity\``);
  try {
    return await module.identity.connect(deps);
  } catch (err) {
    pluginFailed(specifier, err, 'connect');
  }
}
