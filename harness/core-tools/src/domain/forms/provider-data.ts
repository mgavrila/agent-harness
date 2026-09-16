import { eq, sql } from 'drizzle-orm';
import { attachments, fields } from '@harness/db';
import type { ToolDeps } from '../tooling/types.js';
import { requireProvider } from '../providers/repository.js';
import { latestCredential } from './fill.js';
import type { ProviderData, RosterRow } from './types.js';

/**
 * Read everything a template may need about one provider, scoped to the client.
 *
 * Both queries are projections rather than `select()`: the encrypted columns
 * are never pulled into this process, and `number_encrypted IS NOT NULL` is
 * evaluated by Postgres. That is what lets the roster say whether a credential
 * number is on file without the bytes ever being in memory.
 */
export async function loadProviderData(deps: ToolDeps, providerId: string): Promise<ProviderData> {
  const provider = await requireProvider(deps, providerId);
  const fieldRows = await deps.db
    .select({ name: fields.name, value: fields.value, restricted: fields.restricted, status: fields.status })
    .from(fields)
    .where(eq(fields.recordId, providerId));
  const credentialRows = await deps.db
    .select({
      kind: attachments.kind,
      issuer: attachments.issuer,
      state: attachments.state,
      issuedAt: attachments.issuedAt,
      expiresAt: attachments.expiresAt,
      hasNumber: sql<boolean>`${attachments.numberEncrypted} is not null`,
    })
    .from(attachments)
    .where(eq(attachments.recordId, providerId));
  return {
    provider: { name: provider.name, npi: provider.externalId, status: provider.status },
    fields: fieldRows,
    credentials: credentialRows,
  };
}

const fieldValue = (data: ProviderData, name: string): string | null => {
  const row = data.fields.find((f) => f.name === name);
  if (!row || row.restricted) return null;
  return row.status === 'extracted' || row.status === 'verified' ? row.value : null;
};

/**
 * One roster row per provider, in the order given. The ids are used as handed
 * over: a repeated id produces a repeated row, so a caller that must not list a
 * provider twice dedupes before calling.
 */
export async function buildRoster(deps: ToolDeps, payerId: string, providerIds: string[]): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  for (const providerId of providerIds) {
    // requireProvider inside loadProviderData scopes this to deps.client, so
    // one unknown id aborts the whole roster rather than silently skipping.
    const data = await loadProviderData(deps, providerId);
    const license = latestCredential(data, 'license');
    const malpractice = latestCredential(data, 'malpractice');
    const boardCert = latestCredential(data, 'board_cert');
    rows.push({
      payer_id: payerId,
      provider_name: data.provider.name,
      npi: data.provider.npi,
      primary_specialty: fieldValue(data, 'primary_specialty'),
      practice_address: fieldValue(data, 'practice_address'),
      license_state: license?.state ?? null,
      license_issuer: license?.issuer ?? null,
      license_expires_at: license?.expiresAt ?? null,
      // "On file" means a number is stored, not that a credential row
      // exists: `number_encrypted` is nullable, so a licence recorded from a
      // document with no legible number must report no.
      license_number_on_file: license?.hasNumber ?? false,
      dea_on_file: latestCredential(data, 'dea')?.hasNumber ?? false,
      malpractice_carrier: malpractice?.issuer ?? null,
      malpractice_expires_at: malpractice?.expiresAt ?? null,
      board_cert_expires_at: boardCert?.expiresAt ?? null,
      provider_status: data.provider.status,
    });
  }
  return rows;
}
