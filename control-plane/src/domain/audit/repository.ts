import type { Db } from '../db/connect.js';
import { audit } from '../db/schema.js';
import type { AuditEntry } from './types.js';

export async function record(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(audit).values({
    userId: entry.userId,
    organisationId: entry.organisationId,
    agentId: entry.agentId,
    action: entry.action,
    summary: entry.summary,
  });
}
