import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq, sql } from 'drizzle-orm';
import { approvals, encrypt, withTransaction, type Db } from '@harness/db';
import { decide, type ActionClass, type Policy } from './policy.js';
import { hashArgs, writeAudit, type AuditEntry } from './audit.js';
import type { SinkRegistry } from './effects.js';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface SessionContext {
  runId?: string;
  skill?: string;
  skillVersion?: string;
  /** Name of the tool currently executing; set by the registry before calling a handler. */
  tool?: string;
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
  /** External-effect senders keyed by sink name (e.g. 'slack'). Empty in Plan 1.1; Plan 3 registers real ones. */
  sinks: SinkRegistry;
  context: SessionContext;
}

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
  /**
   * Strip restricted values from the arguments before they are written to the
   * approvals table in plaintext jsonb. The full arguments are still stored,
   * encrypted, in `payload_encrypted`. Omit only for tools whose arguments can
   * never carry a restricted value.
   */
  redact?: (args: z.infer<I>) => unknown;
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

/**
 * Park an approval, reusing only a *live pending* row. A row that was decided
 * (approved/declined) or has passed its TTL is history: it must not silently
 * satisfy a fresh request. An expired row is retired first, then a new one is
 * parked. Uniqueness is enforced by the partial index
 * `approvals_idempotency_pending_uq`, so concurrent callers race to one insert
 * and the loser re-reads the winner's row.
 */
async function createOrReuseApproval(db: Db, deps: ToolDeps, tool: AnyToolDef, args: unknown, argsHash: string) {
  const idempotencyKey = `${deps.client}:${tool.name}:${argsHash}`;
  const pendingRow = and(
    eq(approvals.client, deps.client),
    eq(approvals.idempotencyKey, idempotencyKey),
    eq(approvals.status, 'pending'),
  );

  const existing = await db.query.approvals.findFirst({ where: pendingRow });
  if (existing) {
    if (existing.expiresAt > deps.now()) return existing;
    await db
      .update(approvals)
      .set({ status: 'expired', decidedAt: deps.now() })
      .where(eq(approvals.id, existing.id));
  }

  const summary = `${tool.name} (${tool.actionClass}) requested by ${deps.caller}`;
  const expiresAt = new Date(deps.now().getTime() + deps.approvalTtlHours * 3600 * 1000);
  await db
    .insert(approvals)
    .values({
      client: deps.client,
      action: tool.name,
      // Plaintext jsonb for humans reviewing the request; restricted values are
      // redacted out of it. The full arguments live in payload_encrypted.
      payload: { tool: tool.name, args: tool.redact ? tool.redact(args) : args },
      payloadEncrypted: encrypt(JSON.stringify({ tool: tool.name, args }), deps.encryptionKey),
      summary,
      requestedBy: deps.caller,
      expiresAt,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: approvals.idempotencyKey, where: sql`status = 'pending'` });
  const row = await db.query.approvals.findFirst({ where: pendingRow });
  if (!row) throw new Error('approval row missing after insert');
  return row;
}

type AuditBase = Pick<AuditEntry, 'client' | 'caller' | 'tool' | 'actionClass' | 'argsHash'>;

/**
 * Last-resort handler for a failure the normal paths could not record: a
 * throwing `now()`, a DB error while parking an approval, or an audit write
 * that itself failed after a handler threw. Never throws — the audit write is
 * wrapped so a secondary failure cannot escape the MCP callback. The message is
 * deliberately generic; the detail is in the audit log when it could be written.
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
            const row = await withTransaction(deps.db, async (tx) => {
              const parked = await createOrReuseApproval(tx, deps, tool, args, argsHash);
              await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
              return parked;
            });
            const structured = { status: 'pending' as const, approval_id: row.id };
            return { ...textResult(structured), structuredContent: structured };
          } catch (err) {
            return await handleUnexpectedError(deps.db, tool, base, err);
          }
        }

        try {
          const result = await withTransaction(deps.db, async (tx) => {
            const txDeps: ToolDeps = { ...deps, db: tx, context: { ...deps.context, tool: tool.name } };
            const out = await tool.handler(args, txDeps);
            await writeAudit(tx, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, out) ?? [] });
            return out;
          });
          const structured = { status: 'ok' as const, result };
          return { ...textResult(structured), structuredContent: structured };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
      },
    );
  }
}
