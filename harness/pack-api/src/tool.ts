import type * as z from 'zod/v4';
import type { PackToolDeps, ToolDef } from './types.js';

/**
 * One agent-callable action.
 *
 * `TDeps` is the dependency bag the handler receives. A pack leaves it at `PackToolDeps`, the
 * structural view of core's `ToolDeps` that `types.ts` declares; core-tools narrows it to the
 * whole `ToolDeps` for its own tools. `ToolDeps` is assignable to `PackToolDeps`, so a pack's
 * tools drop straight into core-tools' catalogue and the handler is called with the real bag.
 */
export type { AnyToolDef, ToolDef } from './types.js';

/**
 * Declare a tool. The only thing this does at runtime is return its argument; it exists so that
 * `I` and `O` are inferred and a handler's arguments and result are typed from the zod schemas
 * rather than annotated by hand. core-tools has its own copy narrowed over `ToolDeps`; this one
 * is what a pack calls.
 */
export function definePackTool<I extends z.ZodObject, O extends z.ZodObject>(
  def: ToolDef<I, O, PackToolDeps>,
): ToolDef<I, O, PackToolDeps> {
  return def;
}
