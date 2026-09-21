export interface AuditEntry {
  userId: string;
  organisationId?: string;
  agentId?: string;
  action: string;
  summary: string;
}
