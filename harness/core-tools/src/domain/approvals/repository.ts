import { and, eq, sql } from 'drizzle-orm';
import { approvals, encrypt, type Db } from '@harness/db';
import type { ActionClass } from '@harness/pack-api';
import type { AnyToolDef, ToolDeps } from '../tooling/types.js';

/**
 * Park an approval, reusing only a *live pending* row. A row that was decided
 * (approved/declined) or has passed its TTL is history: it must not silently
 * satisfy a fresh request. An expired row is retired first, then a new one is
 * parked. Uniqueness is enforced by the partial index
 * `approvals_client_idempotency_pending_uq`, which is per client, so concurrent
 * callers race to one insert and the loser re-reads the winner's row — and two
 * tenants that mint the same key are two requests rather than one.
 */
export async function createOrReuseApproval(
  db: Db,
  deps: ToolDeps,
  tool: AnyToolDef,
  args: unknown,
  argsHash: string,
  actionClass: ActionClass = tool.actionClass,
): Promise<typeof approvals.$inferSelect> {
  const idempotencyKey = `${deps.client}:${tool.name}:${argsHash}`;
  const pendingRow = and(
    eq(approvals.client, deps.client),
    eq(approvals.idempotencyKey, idempotencyKey),
    eq(approvals.status, 'pending'),
  );

  const existing = await db.query.approvals.findFirst({ where: pendingRow });
  if (existing) {
    if (existing.expiresAt > deps.now()) return existing;
    await db.update(approvals).set({ status: 'expired', decidedAt: deps.now() }).where(eq(approvals.id, existing.id));
  }

  const summary = `${tool.name} (${actionClass}) requested by ${deps.principal.id}`;
  const expiresAt = new Date(deps.now().getTime() + deps.approvalTtlHours * 3600 * 1000);
  await db
    .insert(approvals)
    .values({
      client: deps.client,
      action: tool.name,
      // Plaintext jsonb for humans reviewing the request; restricted values are
      // redacted out of it. The full arguments live in payload_encrypted.
      payload: { tool: tool.name, args: tool.redact ? tool.redact(args) : args },
      payloadEncrypted: encrypt(
        JSON.stringify({ tool: tool.name, args, level: deps.principal.level }),
        deps.encryptionKey,
      ),
      summary,
      requestedBy: deps.principal.id,
      expiresAt,
      idempotencyKey,
      threadId: deps.context.threadId,
    })
    .onConflictDoNothing({ target: [approvals.client, approvals.idempotencyKey], where: sql`status = 'pending'` });
  const row = await db.query.approvals.findFirst({ where: pendingRow });
  if (!row) throw new Error('approval row missing after insert');
  return row;
}
