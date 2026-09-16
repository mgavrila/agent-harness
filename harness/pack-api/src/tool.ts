/**
 * One agent-callable action.
 *
 * `TDeps` is the dependency bag the handler receives. A pack leaves it at `PackToolDeps`, the
 * structural view of core's `ToolDeps` that `types.ts` declares; core-tools narrows it to the
 * whole `ToolDeps` for its own tools. `ToolDeps` is assignable to `PackToolDeps`, so a pack's
 * tools drop straight into core-tools' catalogue and the handler is called with the real bag.
 */
export type { AnyToolDef, ToolDef } from './types.js';
