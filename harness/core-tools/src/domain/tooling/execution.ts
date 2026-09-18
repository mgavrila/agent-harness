import * as z from 'zod/v4';
import { withTransaction, type Db } from '@harness/db';
import { ToolError, describeError } from '@harness/shared';
import { createOrReuseApproval } from '../approvals/repository.js';
import { writeAudit } from './audit.js';
import { withCurrentTool } from './context.js';
import type { AnyToolDef, AuditBase, Envelope, ToolCallResult, ToolDeps } from './types.js';

/** The envelope every tool's output is wrapped in, so a parked call and a completed one have one shape. */
export function envelope<O extends z.ZodObject>(output: O) {
  return z.object({
    status: z.enum(['ok', 'pending']),
    approval_id: z.string().optional(),
    result: output.optional(),
  });
}

function textResult(payload: unknown, isError = false): ToolCallResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], isError };
}

/** A successful call: the envelope is returned both as text and as structured content. */
function envelopeResult(structured: Envelope): ToolCallResult {
  return { ...textResult(structured), structuredContent: structured };
}

/**
 * Last-resort handler for a failure the normal paths could not record: a
 * throwing `now()`, a DB error while parking an approval, or an audit write
 * that itself failed after a handler threw. Never throws — the audit write is
 * wrapped so a secondary failure cannot escape the MCP callback. The message is
 * deliberately generic; the detail is in the audit log when it could be written.
 */
export async function handleUnexpectedError(
  db: Db,
  tool: AnyToolDef,
  base: AuditBase,
  err: unknown,
): Promise<ToolCallResult> {
  try {
    await writeAudit(db, { ...base, decision: 'error', error: describeError(err) });
  } catch {
    // best-effort audit write; swallow secondary failure so the callback never throws
  }
  return textResult(`Tool ${tool.name} could not be processed (internal error; see audit log).`, true);
}

/** Policy says no: record the refusal and tell the caller, without running anything. */
export async function runBlocked(deps: ToolDeps, tool: AnyToolDef, base: AuditBase): Promise<ToolCallResult> {
  try {
    await writeAudit(deps.db, { ...base, decision: 'blocked' });
  } catch (err) {
    return await handleUnexpectedError(deps.db, tool, base, err);
  }
  return textResult(`Tool ${tool.name} is blocked by policy (action class ${base.actionClass}).`, true);
}

/**
 * Policy says a human decides: park the request and return its approval id.
 * The parked row and its audit row commit together, so a request a caller was
 * told about is always one an approver can find.
 */
export async function runForApproval(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const row = await withTransaction(deps.db, async (tx) => {
      const parked = await createOrReuseApproval(tx, deps, tool, args, base.argsHash, base.actionClass);
      await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
      return parked;
    });
    return envelopeResult({ status: 'pending', approval_id: row.id });
  } catch (err) {
    return await handleUnexpectedError(deps.db, tool, base, err);
  }
}

/**
 * Policy says go: run the handler and its audit row in one transaction, so a
 * handler that throws leaves neither its writes nor a success row behind. The
 * raw message reaches the caller only for a `ToolError`, which a tool raises
 * deliberately; anything else could carry restricted values and stays in the
 * audit log.
 */
export async function runAuto(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const result = await withTransaction(deps.db, async (tx) => {
      // Spread keeps the run's context object, which withCurrentTool stamps the tool name on.
      const txDeps: ToolDeps = { ...deps, db: tx };
      return await withCurrentTool(deps.context, tool.name, async () => {
        const out = await tool.handler(args, txDeps);
        await writeAudit(tx, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, out) ?? [] });
        return out;
      });
    });
    return envelopeResult({ status: 'ok', result });
  } catch (err) {
    const message = describeError(err);
    try {
      await writeAudit(deps.db, { ...base, decision: 'error', error: message });
    } catch (auditErr) {
      return await handleUnexpectedError(deps.db, tool, base, auditErr);
    }
    const text =
      err instanceof ToolError
        ? `Tool ${tool.name} failed: ${message}`
        : `Tool ${tool.name} failed (internal error; see audit log).`;
    return textResult(text, true);
  }
}
