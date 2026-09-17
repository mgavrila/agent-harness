import { ConfigError, createLogger } from '@harness/shared';
import type { Surface, SurfaceDeps, SurfaceSession } from '@harness/surface-api';

const log = createLogger('approvals');

/** Shared between `loadSurfaces` and `surfacesOf`, which refuse an empty list the same way. */
const NO_SURFACES_MESSAGE = 'HARNESS_SURFACES names no surface; at least one is required';

/**
 * The surfaces this host connected to.
 *
 * **The primary surface rule.** The first entry of `HARNESS_SURFACES` is where approval cards are
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
  /** Throws `ConfigError` when no loaded surface has that name. */
  byName(name: string): SurfaceSession;
}

/** A set over sessions that are already in hand. Every test uses it; `loadSurfaces` builds one. */
export function surfacesOf(sessions: SurfaceSession[], secrets: readonly string[] = []): LoadedSurfaces {
  if (sessions.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  return {
    all: sessions,
    primary: sessions[0],
    secrets,
    find: (name) => sessions.find((s) => s.name === name),
    byName(name) {
      const found = sessions.find((s) => s.name === name);
      if (!found) throw new ConfigError(`no surface named "${name}" is loaded`);
      return found;
    },
  };
}

/**
 * Load and connect the surfaces `HARNESS_SURFACES` names.
 *
 * The specifier is a variable, so this is the one place in the host that reaches an adapter at
 * all, and it reaches it the way a plug-in host does: by name, at startup, with no build-time
 * edge. `pnpm arch` forbids a static `@harness/surface-*` import anywhere else under `src/`.
 * It is deliberately the same shape as the kernel's `loadPacks`, down to the three ways a
 * dynamic import can fail, because an operator who has debugged one has debugged both:
 *
 *  - the specifier does not resolve — the resolver's own message carries absolute paths and a
 *    node_modules layout that does not belong in a container log, so it is replaced;
 *  - the module evaluates and throws a `ConfigError` — safe by construction, so it is re-raised
 *    with the adapter's name in front;
 *  - anything else — logged in full and replaced with a message naming only the adapter.
 *
 * Connecting happens here too, in order, and through the same three-way funnel, so a surface
 * that cannot be reached is a startup failure naming the adapter rather than an approval nobody
 * sees. Each entry keeps the specifier it was named by: that is the string the operator wrote in
 * `HARNESS_SURFACES`, so it is the string every message here quotes.
 */
export async function loadSurfaces(names: string[], deps: SurfaceDeps): Promise<LoadedSurfaces> {
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
      if (err instanceof ConfigError) throw new ConfigError(`surface "${specifier}": ${err.message}`);
      log.error(`surface "${specifier}" failed to initialise`, err);
      throw new ConfigError(`surface "${specifier}" failed to initialise`);
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
    // Reading a missing credential is the ordinary way `connect` fails, and an adapter reports
    // it as a `ConfigError` — safe by construction, so it is re-raised with the adapter in
    // front. Anything else may carry a token or a socket path, so it is logged and replaced.
    try {
      sessions.push(await surface.connect(deps));
    } catch (err) {
      if (err instanceof ConfigError) throw new ConfigError(`surface "${specifier}": ${err.message}`);
      log.error(`surface "${specifier}" failed to connect`, err);
      throw new ConfigError(`surface "${specifier}" failed to connect`);
    }
  }
  return surfacesOf(sessions, [...new Set(declared.flatMap((d) => [...d.surface.secrets]))]);
}
