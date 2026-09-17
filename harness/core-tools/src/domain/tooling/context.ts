import type { AnyToolDef, AuditBase, SessionContext, ToolDeps } from './types.js';

/**
 * The identity every audit row carries: who called, which tool, under what
 * session context. One definition so a row written outside the registry — the
 * replay in `approvals_execute` — cannot drift from the rows the registry
 * writes. `derivedFrom` is the caller's lineage claim, not read from context.
 */
export function auditBaseFor(
  deps: ToolDeps,
  tool: AnyToolDef,
  argsHash: string,
  derivedFrom: string[] = [],
): AuditBase {
  return {
    client: deps.client,
    caller: deps.principal.id,
    tool: tool.name,
    actionClass: tool.actionClass,
    argsHash,
    runId: deps.context.runId ?? null,
    skill: deps.context.skill ?? null,
    skillVersion: deps.context.skillVersion ?? null,
    derivedFrom,
  };
}

/**
 * Undo in-place mutations a handler made to the shared session context when
 * its transaction did not commit. A handler (e.g. `harness_set_context`) may
 * set `deps.context.runId` and insert the matching `runs` row in the same
 * transaction; if that transaction rolls back (a later write throws, the
 * audit write fails, etc.) the in-memory context must not keep pointing at a
 * row that was never persisted, or every later audit write would fail the
 * `audit_log.run_id` foreign key.
 */
function restoreContext(target: SessionContext, snapshot: SessionContext): void {
  for (const key of Object.keys(target) as (keyof SessionContext)[]) delete target[key];
  // Only the keys that actually held a value are put back. A snapshot taken
  // while a key held `undefined` must not reinstate it as an own property, or
  // `'tool' in context` would stay true for a tool that is no longer running:
  // absent and explicitly-undefined have to look the same.
  for (const key of Object.keys(snapshot) as (keyof SessionContext)[]) {
    const value = snapshot[key];
    if (value !== undefined) target[key] = value;
  }
}

/** Run `fn`, rewinding the shared session context to its prior state if `fn` throws. */
export async function preservingContext<T>(context: SessionContext, fn: () => Promise<T>): Promise<T> {
  const snapshot: SessionContext = { ...context };
  try {
    return await fn();
  } catch (err) {
    restoreContext(context, snapshot);
    throw err;
  }
}

/**
 * Run `fn` with `context.tool` naming the tool being executed, so that anything
 * the handler stages (an effect row, say) is attributed to it, and restore the
 * previous name afterwards. Nesting is why the old value is put back rather
 * than cleared: `approvals_execute` replays another tool inside its own call.
 */
export async function withCurrentTool<T>(context: SessionContext, tool: string, fn: () => Promise<T>): Promise<T> {
  const previous = context.tool;
  context.tool = tool;
  try {
    return await fn();
  } finally {
    context.tool = previous;
  }
}
