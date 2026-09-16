import type * as z from 'zod/v4';
import type { PackToolDeps } from './kernel.js';
import type { ActionClass } from './policy.js';

/**
 * One agent-callable action.
 *
 * `TDeps` is the dependency bag the handler receives. A pack leaves it at `PackToolDeps`, the
 * structural view of core's `ToolDeps` that `kernel.ts` declares; core-tools narrows it to the
 * whole `ToolDeps` for its own tools. `ToolDeps` is assignable to `PackToolDeps`, so a pack's
 * tools drop straight into core-tools' catalogue and the handler is called with the real bag.
 */
export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject, TDeps = PackToolDeps> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: TDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
  /**
   * Strip restricted values from the arguments before they are written to the approvals table
   * in plaintext jsonb. The full arguments are still stored, encrypted, in
   * `payload_encrypted`. Omit only for tools whose arguments can never carry a restricted
   * value.
   */
  redact?: (args: z.infer<I>) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef<TDeps = PackToolDeps> = ToolDef<any, any, TDeps>;
