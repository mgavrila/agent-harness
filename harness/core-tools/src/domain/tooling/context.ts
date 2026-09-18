import type { ActionClass } from '@harness/pack-api';
import type { AnyToolDef, AuditBase, RunContext, ToolDeps } from './types.js';

/**
 * The identity every audit row carries: who called, which tool, under what
 * run context. One definition so a row written outside the registry — the
 * replay in `approvals_execute` — cannot drift from the rows the registry
 * writes. `derivedFrom` is the caller's lineage claim, not read from context.
 */
export function auditBaseFor(
  deps: ToolDeps,
  tool: AnyToolDef,
  argsHash: string,
  derivedFrom: string[] = [],
  actionClass: ActionClass = tool.actionClass,
): AuditBase {
  return {
    client: deps.client,
    caller: deps.principal.id,
    tool: tool.name,
    actionClass,
    argsHash,
    runId: deps.context.runId ?? null,
    skill: deps.context.skill ?? null,
    skillVersion: deps.context.skillVersion ?? null,
    derivedFrom,
  };
}

/**
 * Run `fn` with `context.tool` naming the tool being executed, so that anything
 * the handler stages (an effect row, say) is attributed to it, and restore the
 * previous name afterwards. Nesting is why the old value is put back rather
 * than cleared: `approvals_execute` replays another tool inside its own call.
 */
export async function withCurrentTool<T>(context: RunContext, tool: string, fn: () => Promise<T>): Promise<T> {
  const previous = context.tool;
  context.tool = tool;
  try {
    return await fn();
  } finally {
    context.tool = previous;
  }
}
