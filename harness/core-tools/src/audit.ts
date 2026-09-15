import { createHash } from 'node:crypto';
import { auditLog, type Db } from '@harness/db';
import type { ActionClass } from './policy.js';

export type Decision = 'auto' | 'approval' | 'blocked' | 'error';

export interface AuditEntry {
  client: string;
  caller: string;
  tool: string;
  actionClass: ActionClass;
  argsHash: string;
  decision: Decision;
  recordIds?: string[];
  approvalId?: string | null;
  runId?: string | null;
  error?: string | null;
}

export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    client: entry.client,
    caller: entry.caller,
    tool: entry.tool,
    actionClass: entry.actionClass,
    argsHash: entry.argsHash,
    decision: entry.decision,
    recordIds: entry.recordIds ?? [],
    approvalId: entry.approvalId ?? null,
    runId: entry.runId ?? null,
    error: entry.error ?? null,
  });
}
