import { ToolError } from '@harness/shared';
import type { PackToolDeps } from '@harness/pack-api';

/**
 * Call a kernel tool by name.
 *
 * Always `deps.kernelTools`, never `deps.tools`: the published catalogue holds this pack's
 * wrappers under `documents_ingest` and `deadlines_compute`, so a lookup there would find the
 * wrapper and recurse.
 *
 * A missing tool is a `ToolError` rather than a crash: it can only happen if the loaded
 * catalogue and this pack disagree about what the kernel publishes, and the message names the
 * tool so the disagreement is obvious.
 */
export async function callKernel<T>(deps: PackToolDeps, name: string, args: unknown): Promise<T> {
  const tool = deps.kernelTools.get(name);
  if (!tool) throw new ToolError(`kernel tool "${name}" is not loaded`);
  return (await tool.handler(args, deps)) as T;
}
