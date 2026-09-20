import { ConfigError } from '@harness/shared';

/** A plug-in name: the same rule `defineSurface`, the identity plug-in definer and `defineRuntime` apply. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The package a plug-in name resolves to.
 *
 * **The specifier is built here and written nowhere.** A client document names its surfaces, its
 * identity plug-in and its runtime by *name* — and this turns a name into `@harness/<kind>-<name>`
 * with a template. That is not an aesthetic choice: the vocabulary scan of `harness/host/src`
 * forbids a messaging vendor's name and an agent framework's name in host source, precisely so
 * that the one process every client runs cannot learn which transport or which framework it is
 * serving. A literal here would be that coupling, written down.
 *
 * A name that is not a plug-in name is refused rather than joined into a specifier: the document
 * is data a tenant wrote, and `import('@harness/surface-../../evil')` is a thing a template will
 * happily build.
 */
function specifierFor(kind: 'surface' | 'identity' | 'runtime', name: string): string {
  if (!PLUGIN_NAME.test(name)) {
    throw new ConfigError(`"${name}" is not a ${kind} name; one is lowercase letters, digits and hyphens`);
  }
  return `@harness/${kind}-${name}`;
}

export const surfaceSpecifier = (name: string): string => specifierFor('surface', name);
export const identitySpecifier = (kind: string): string => specifierFor('identity', kind);
export const runtimeSpecifier = (name: string): string => specifierFor('runtime', name);
