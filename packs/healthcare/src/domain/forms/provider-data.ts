import type { PackToolDeps, RecordsGetResult } from '@harness/pack-api';
import { callKernel } from '../../shared/kernel-call.js';
import { latestCredential } from './fill.js';
import type { ProviderData, RosterRow } from './types.js';

/**
 * Read everything a template may need about one provider.
 *
 * This used to be two SQL projections. A pack has no database handle — it reaches the store
 * only through kernel tools — so it goes through `records_get`, which client-scopes the read,
 * masks every restricted value and reports a credential number as on-file or not without the
 * bytes ever being in this process. That is the same guarantee the projections gave, enforced
 * in one place instead of two.
 */
export async function loadProviderData(deps: PackToolDeps, providerId: string): Promise<ProviderData> {
  // `kind: 'provider'` like every other read this pack makes: a form template describes a
  // provider, so another pack's record reaching here is a `ToolError` naming both kinds rather
  // than an epic filled into a credentialing PDF.
  const r = await callKernel<RecordsGetResult>(deps, 'records_get', { record_id: providerId, kind: 'provider' });
  return {
    provider: { name: r.record.name, npi: r.record.external_id, status: r.record.status },
    fields: r.fields.map((f) => ({ name: f.name, value: f.value, restricted: f.restricted, status: f.status })),
    credentials: r.attachments.map((a) => ({
      kind: a.kind,
      issuer: a.issuer,
      state: a.state,
      issuedAt: a.issued_at,
      expiresAt: a.expires_at,
      // `number` is the mask sentinel when a number is on file and null when none is, so this
      // is the same boolean `number_encrypted IS NOT NULL` produced, with the same meaning: a
      // licence recorded from a document that showed no legible number answers no.
      hasNumber: a.number !== null,
    })),
  };
}

const fieldValue = (data: ProviderData, name: string): string | null => {
  const row = data.fields.find((f) => f.name === name);
  if (!row || row.restricted) return null;
  return row.status === 'extracted' || row.status === 'verified' ? row.value : null;
};

/**
 * One roster row per provider, in the order given. The ids are used as handed over: a repeated
 * id produces a repeated row, so a caller that must not list a provider twice dedupes before
 * calling.
 */
export async function buildRoster(deps: PackToolDeps, payerId: string, providerIds: string[]): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  for (const providerId of providerIds) {
    // records_get is client-scoped and throws on an unknown id, so one bad id aborts the whole
    // roster rather than silently skipping it.
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
