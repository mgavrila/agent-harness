import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq, sql } from 'drizzle-orm';
import { approvals, encrypt, withTransaction, type Db } from '@harness/db';
import { decide, type ActionClass, type Policy } from './policy.js';
import { hashArgs, writeAudit, type AuditEntry } from './audit.js';
import type { SinkRegistry } from './effects.js';
import type { GatewayConfig } from './models.js';

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
  /** How to reach the model gateway. Every model call goes through it. */
  gateway: GatewayConfig;
  /** Absolute directory documents are read from and written under. Nothing outside it is readable. */
  storageDir: string;
  /**
   * Whether restricted identifiers (SSN, EIN, DEA) may be sent to a model.
   * False for every client by default. Turning it on is a documented decision
   * that requires a BAA with the model provider (spec section 4.4).
   */
  restrictedToModel: boolean;
  /** External-effect senders keyed by sink name (e.g. 'slack'). Empty in Plan 1.1; Plan 3 registers real ones. */
  sinks: SinkRegistry;
  context: SessionContext;
  /** Every registered tool, keyed by name, so a parked action can be replayed by name. Filled by `registerTools`. */
  tools: Map<string, AnyToolDef>;
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

/** A call either produced a result or was parked for a human decision. */
type Envelope = { status: 'ok'; result: unknown } | { status: 'pending'; approval_id: string };

/**
 * What a tool call resolves to. A type alias rather than an interface, so that
 * it keeps the implicit index signature the MCP callback signature expects.
 */
type ToolCallResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent?: Envelope;
};

function textResult(payload: unknown, isError = false): ToolCallResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], isError };
}

/** A successful call: the envelope is returned both as text and as structured content. */
function envelopeResult(structured: Envelope): ToolCallResult {
  return { ...textResult(structured), structuredContent: structured };
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

export type AuditBase = Pick<
  AuditEntry,
  'client' | 'caller' | 'tool' | 'actionClass' | 'argsHash' | 'runId' | 'skill' | 'skillVersion' | 'derivedFrom'
>;

/**
 * The identity every audit row carries: who called, which tool, under what
 * session context. One definition so a row written outside the registry — the
 * replay in `approvals_execute` — cannot drift from the rows the registry
 * writes. `derivedFrom` is the caller's lineage claim, not read from context.
 */
export function auditBaseFor(deps: ToolDeps, tool: AnyToolDef, argsHash: string, derivedFrom: string[] = []): AuditBase {
  return {
    client: deps.client,
    caller: deps.caller,
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
 * Last-resort handler for a failure the normal paths could not record: a
 * throwing `now()`, a DB error while parking an approval, or an audit write
 * that itself failed after a handler threw. Never throws — the audit write is
 * wrapped so a secondary failure cannot escape the MCP callback. The message is
 * deliberately generic; the detail is in the audit log when it could be written.
 */
async function handleUnexpectedError(db: Db, tool: AnyToolDef, base: AuditBase, err: unknown): Promise<ToolCallResult> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await writeAudit(db, { ...base, decision: 'error', error: message });
  } catch {
    // best-effort audit write; swallow secondary failure so the callback never throws
  }
  return textResult(`Tool ${tool.name} could not be processed (internal error; see audit log).`, true);
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
  for (const key of Object.keys(target) as (keyof SessionContext)[]) {
    if (!(key in snapshot)) delete target[key];
  }
  Object.assign(target, snapshot);
  // A snapshot taken while a key held `undefined` would otherwise reinstate it
  // as an own property, so `'tool' in context` stays true for a tool that is
  // no longer running. Absent and explicitly-undefined must look the same.
  for (const key of Object.keys(target) as (keyof SessionContext)[]) {
    if (target[key] === undefined) delete target[key];
  }
}

/** Run `fn`, rewinding the shared session context to its prior state if `fn` throws. */
async function preservingContext<T>(context: SessionContext, fn: () => Promise<T>): Promise<T> {
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

/** Policy says no: record the refusal and tell the caller, without running anything. */
async function runBlocked(deps: ToolDeps, tool: AnyToolDef, base: AuditBase): Promise<ToolCallResult> {
  try {
    await writeAudit(deps.db, { ...base, decision: 'blocked' });
  } catch (err) {
    return await handleUnexpectedError(deps.db, tool, base, err);
  }
  return textResult(`Tool ${tool.name} is blocked by policy (action class ${tool.actionClass}).`, true);
}

/**
 * Policy says a human decides: park the request and return its approval id.
 * The parked row and its audit row commit together, so a request a caller was
 * told about is always one an approver can find.
 */
async function runForApproval(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const row = await preservingContext(deps.context, () =>
      withTransaction(deps.db, async (tx) => {
        const parked = await createOrReuseApproval(tx, deps, tool, args, base.argsHash);
        await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
        return parked;
      }),
    );
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
async function runAuto(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const result = await preservingContext(deps.context, () =>
      withTransaction(deps.db, async (tx) => {
        // Spread keeps the one shared context object, which the handler may mutate.
        const txDeps: ToolDeps = { ...deps, db: tx };
        return await withCurrentTool(deps.context, tool.name, async () => {
          const out = await tool.handler(args, txDeps);
          await writeAudit(tx, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, out) ?? [] });
          return out;
        });
      }),
    );
    return envelopeResult({ status: 'ok', result });
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
}

export function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void {
  for (const tool of tools) deps.tools.set(tool.name, tool);
  for (const tool of tools) {
    const inputSchema = tool.input.extend({
      derived_from: z
        .array(z.string().uuid())
        .max(50)
        .optional()
        .describe('audit_log ids of earlier results these arguments were built from'),
    });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema, outputSchema: envelope(tool.output) },
      async (args: Record<string, unknown>) => {
        // `derived_from` is the registry's own argument: it is audited as lineage
        // and never reaches the handler or the arguments hash.
        const { derived_from, ...handlerArgs } = args as Record<string, unknown> & { derived_from?: string[] };
        const base = auditBaseFor(deps, tool, hashArgs(handlerArgs), derived_from ?? []);

        switch (decide(tool.actionClass, deps.policy)) {
          case 'blocked':
            return await runBlocked(deps, tool, base);
          case 'approval':
            return await runForApproval(deps, tool, base, handlerArgs);
          default:
            return await runAuto(deps, tool, base, handlerArgs);
        }
      },
    );
  }
}
