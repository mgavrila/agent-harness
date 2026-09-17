/**
 * This pack's name, in one place.
 *
 * `definePack` declares it and `deps.packs.byName` answers to it, and the two have to agree: a
 * wrapper in `tools/aliases/documents.ts` looks this pack up by name to work out which document
 * kinds belong to somebody else, and a name that had drifted from the declared one would not fail
 * at the edit — it would fail at startup, as a `ConfigError` reading `no pack named "…" is
 * loaded`, in whatever deployment happened to load this pack first.
 *
 * A module of its own rather than a constant exported from either side, because both sides need
 * it and `src/index.ts` already imports `src/tools/`: the constant has to sit under both, or the
 * import graph acquires a cycle that `pnpm arch` fails.
 */
export const PACK_NAME = 'healthcare';
