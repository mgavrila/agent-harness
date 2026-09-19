import type * as z from 'zod/v4';
import type { PackToolDeps, ToolDef } from './types.js';

/** Both declared in `types.ts`, which holds every declaration on the `Pack` ↔ `PackToolDeps` cycle. */
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
