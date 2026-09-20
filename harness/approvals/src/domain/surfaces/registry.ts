import { ConfigError, createLogger } from '@harness/shared';
import type { Surface, SurfaceDeps, SurfaceSession } from '@harness/surface-api';

const log = createLogger('approvals');

/** Shared between `loadSurfaces` and `surfacesOf`, which refuse an empty list the same way. */
const NO_SURFACES_MESSAGE = 'this client declares no surface; at least one is required';

/**
 * The surfaces this host connected to.
 *
 * **The primary surface rule.** The first surface the caller names is where approval cards are
 * posted. One approval, one card, one place to answer it; posting the same approval on several
 * surfaces at once is a feature, not a refactor, and waits for the deployment that needs it.
 * Every other surface is still live: a decision is accepted from whichever surface the row says
 * the card went to, and an effect addressed by name reaches any of them.
 */
export interface LoadedSurfaces {
  readonly all: readonly SurfaceSession[];
  readonly primary: SurfaceSession;
  /** The union of every loaded adapter's declared credentials, for the child-process allowlist. */
  readonly secrets: readonly string[];
  /** `undefined` when no loaded surface has that name; the caller decides whether that is an error. */
  find(name: string): SurfaceSession | undefined;
}

/** A set over sessions that are already in hand. Every test uses it; `loadSurfaces` builds one. */
export function surfacesOf(sessions: SurfaceSession[], secrets: readonly string[] = []): LoadedSurfaces {
  if (sessions.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  return {
    all: sessions,
    primary: sessions[0],
    secrets,
    find: (name) => sessions.find((s) => s.name === name),
  };
}

/**
 * How importing and connecting both report a surface that will not load.
 *
 * A `ConfigError` is safe by construction — an adapter raises one for a missing credential, and
 * the operator needs to know which of the surfaces they listed is complaining — so it is
 * re-raised with the specifier in front. Anything else may carry a token or a socket path, so it
 * is logged in full and replaced with a message naming only the adapter.
 */
function surfaceFailed(specifier: string, err: unknown, stage: 'initialise' | 'connect'): never {
  if (err instanceof ConfigError) throw new ConfigError(`surface "${specifier}": ${err.message}`);
  log.error(`surface "${specifier}" failed to ${stage}`, err);
  throw new ConfigError(`surface "${specifier}" failed to ${stage}`);
}

/**
 * Load and connect the surfaces the caller names — the client document's, in the order its
 * schema fixes.
 *
 * The specifier is a variable, so this is the one place in the host that reaches an adapter at
 * all, and it reaches it the way a plug-in host does: by name, at startup, with no build-time
 * edge. `pnpm arch` forbids a static `@harness/surface-*` import anywhere else under `src/`.
 * It is deliberately the same shape as the kernel's `loadPacks`, down to the three ways a
 * dynamic import can fail, because an operator who has debugged one has debugged both: an
 * unresolvable specifier is replaced, because the resolver's own message carries absolute paths
 * and a node_modules layout that does not belong in a container log, and the other two go
 * through `surfaceFailed`.
 *
 * Connecting happens here too, in order, and through the same funnel, so a surface that cannot be
 * reached is a startup failure naming the adapter rather than an approval nobody sees. Each entry
 * keeps the specifier it was named by, so that is the string every message here quotes.
 *
 * `tenantKeys` is the client's declared key per surface name — `tenantKeysOf(document)`, which is
 * where the typed surface sections are read — handed to each adapter as its own `tenantKey`. A
 * surface whose transport reports the workspace an event came from has no use for it.
 */
export async function loadSurfaces(
  names: string[],
  deps: SurfaceDeps,
  tenantKeys: Readonly<Record<string, string>> = {},
): Promise<LoadedSurfaces> {
  if (names.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  const declared: { specifier: string; surface: Surface }[] = [];
  for (const specifier of names) {
    let module: { surface?: Surface };
    try {
      module = (await import(specifier)) as { surface?: Surface };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw new ConfigError(
          `cannot load surface "${specifier}"; add it to @harness/approvals dependencies and run pnpm install`,
        );
      }
      surfaceFailed(specifier, err, 'initialise');
    }
    if (!module.surface) throw new ConfigError(`module "${specifier}" exports no \`surface\``);
    declared.push({ specifier, surface: module.surface });
  }

  // Two adapters answering to one name would make `approvals.surface` ambiguous: a decision
  // would be authorised against whichever allowlist loaded first, and a named effect would
  // reach whichever one `find` happened to return.
  const seen = new Set<string>();
  for (const { surface } of declared) {
    if (seen.has(surface.name)) {
      throw new ConfigError(
        `two loaded surfaces are both named "${surface.name}"; a surface name identifies one adapter`,
      );
    }
    seen.add(surface.name);
  }

  const sessions: SurfaceSession[] = [];
  for (const { specifier, surface } of declared) {
    try {
      sessions.push(
        await surface.connect(surface.name in tenantKeys ? { ...deps, tenantKey: tenantKeys[surface.name] } : deps),
      );
    } catch (err) {
      surfaceFailed(specifier, err, 'connect');
    }
  }
  return surfacesOf(sessions, [...new Set(declared.flatMap((d) => [...d.surface.secrets]))]);
}
