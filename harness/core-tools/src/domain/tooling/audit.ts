import { auditLog, type Db } from '@harness/db';
import { hashArgs } from '@harness/shared';
import type { ActionClass } from './policy.js';

export { hashArgs };

/**
 * `unauthorised` is the host's own decision (spec 3.2): a message from nobody the identity plug-in
 * knows. `refused` is the other one: a request a surface turned away at the door — an unsigned
 * one, a stale one, one naming another tenant — where nobody was identified at all, so nobody was
 * refused authorisation. Two words because an operator reading the audit log has two questions.
 */
export type Decision = 'auto' | 'approval' | 'blocked' | 'error' | 'unauthorised' | 'refused';

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
  skill?: string | null;
  skillVersion?: string | null;
  derivedFrom?: string[];
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
    skill: entry.skill ?? null,
    skillVersion: entry.skillVersion ?? null,
    derivedFrom: entry.derivedFrom ?? [],
  });
}
