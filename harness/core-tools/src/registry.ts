import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { decide, type ActionClass, type Policy } from './policy.js';
import { hashArgs, writeAudit, type AuditEntry } from './audit.js';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolDeps {
  db: Db;
  client: string;
  caller: string;
  policy: Policy;
  encryptionKey: Buffer;
  now: () => Date;
  approvalTtlHours: number;
  confidenceThreshold: number;
}

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any, any>;

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

function envelope<O extends z.ZodObject>(output: O) {
  return z.object({
    status: z.enum(['ok', 'pending']),
    approval_id: z.string().optional(),
    result: output.optional(),
  });
}

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError };
}

async function createOrReuseApproval(db: Db, deps: ToolDeps, tool: AnyToolDef, args: unknown, argsHash: string) {
  const idempotencyKey = `${deps.client}:${tool.name}:${argsHash}`;
  const summary = `${tool.name} (${tool.actionClass}) requested by ${deps.caller}`;
  const expiresAt = new Date(deps.now().getTime() + deps.approvalTtlHours * 3600 * 1000);
  await db
    .insert(approvals)
    .values({
      client: deps.client,
      action: tool.name,
      payload: { tool: tool.name, args },
      summary,
      requestedBy: deps.caller,
      expiresAt,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: approvals.idempotencyKey });
  const row = await db.query.approvals.findFirst({
    where: and(eq(approvals.idempotencyKey, idempotencyKey), eq(approvals.client, deps.client)),
  });
  if (!row) throw new Error('approval row missing after insert');
  return row;
}

type AuditBase = Pick<AuditEntry, 'client' | 'caller' | 'tool' | 'actionClass' | 'argsHash'>;

/**
 * Last-resort handler for failures on the blocked/approval paths (e.g. a
 * throwing `now()`, or a DB error while parking an approval). Never throws:
 * the audit write is itself wrapped so a secondary failure cannot escape.
 * The caller (blocked/approval branch) never runs its own handler here, so
 * this only ever reports an internal error, never a handler failure.
 */
async function handleUnexpectedError(db: Db, tool: AnyToolDef, base: AuditBase, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await writeAudit(db, { ...base, decision: 'error', error: message });
  } catch {
    // best-effort audit write; swallow secondary failure so the callback never throws
  }
  return textResult(`Tool ${tool.name} could not be processed (internal error; see audit log).`, true);
}

export function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, outputSchema: envelope(tool.output) },
      async (args: Record<string, unknown>) => {
        const behavior = decide(tool.actionClass, deps.policy);
        const argsHash = hashArgs(args);
        const base = { client: deps.client, caller: deps.caller, tool: tool.name, actionClass: tool.actionClass, argsHash };

        if (behavior === 'blocked') {
          try {
            await writeAudit(deps.db, { ...base, decision: 'blocked' });
            return textResult(`Tool ${tool.name} is blocked by policy (action class ${tool.actionClass}).`, true);
          } catch (err) {
            return await handleUnexpectedError(deps.db, tool, base, err);
          }
        }

        if (behavior === 'approval') {
          try {
            const row = await createOrReuseApproval(deps.db, deps, tool, args, argsHash);
            await writeAudit(deps.db, { ...base, decision: 'approval', approvalId: row.id });
            const structured = { status: 'pending' as const, approval_id: row.id };
            return { ...textResult(structured), structuredContent: structured };
          } catch (err) {
            return await handleUnexpectedError(deps.db, tool, base, err);
          }
        }

        try {
          const result = await tool.handler(args, deps);
          await writeAudit(deps.db, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, result) ?? [] });
          const structured = { status: 'ok' as const, result };
          return { ...textResult(structured), structuredContent: structured };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await writeAudit(deps.db, { ...base, decision: 'error', error: message });
          const text =
            err instanceof ToolError
              ? `Tool ${tool.name} failed: ${message}`
              : `Tool ${tool.name} failed (internal error; see audit log).`;
          return textResult(text, true);
        }
      },
    );
  }
}
