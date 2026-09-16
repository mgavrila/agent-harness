import type * as z from 'zod/v4';
import type { ActionClass } from './policy.js';

/**
 * One agent-callable action.
 *
 * `TDeps` is the dependency bag the handler receives. A pack that ships tools leaves it at
 * `unknown` — it cannot see core-tools' `ToolDeps` — and core-tools narrows it to `ToolDeps`
 * for its own tools. A handler typed `(args, deps: unknown) => …` is assignable to one typed
 * `(args, deps: ToolDeps) => …`, so a pack's tools drop straight into core-tools' catalogue.
 */
export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject, TDeps = unknown> {
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
export type AnyToolDef<TDeps = unknown> = ToolDef<any, any, TDeps>;
