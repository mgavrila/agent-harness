import { csvCell } from '@harness/shared';

/**
 * The payer roster CSV. The column list is a contract with the payer, so it is
 * a frozen array rather than a shape inferred from the data: adding a column
 * is a deliberate edit here and in packs/healthcare/forms/README.md.
 */
export const ROSTER_COLUMNS = [
  'payer_id',
  'provider_name',
  'npi',
  'primary_specialty',
  'practice_address',
  'license_state',
  'license_issuer',
  'license_expires_at',
  'license_number_on_file',
  'dea_on_file',
  'malpractice_carrier',
  'malpractice_expires_at',
  'board_cert_expires_at',
  'provider_status',
] as const;

export interface RosterRow {
  payer_id: string;
  provider_name: string;
  npi: string | null;
  primary_specialty: string | null;
  practice_address: string | null;
  license_state: string | null;
  license_issuer: string | null;
  license_expires_at: string | null;
  /** Whether a licence number is on file. The number itself is encrypted and never exported. */
  license_number_on_file: boolean;
  /** Whether a DEA registration is on file. The number itself is encrypted and never exported. */
  dea_on_file: boolean;
  malpractice_carrier: string | null;
  malpractice_expires_at: string | null;
  board_cert_expires_at: string | null;
  provider_status: string;
}

const yesNo = (on: boolean): string => (on ? 'yes' : 'no');

export function buildRosterCsv(rows: RosterRow[]): string {
  const lines = [ROSTER_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.payer_id),
        csvCell(r.provider_name),
        csvCell(r.npi),
        csvCell(r.primary_specialty),
        csvCell(r.practice_address),
        csvCell(r.license_state),
        csvCell(r.license_issuer),
        csvCell(r.license_expires_at),
        yesNo(r.license_number_on_file),
        yesNo(r.dea_on_file),
        csvCell(r.malpractice_carrier),
        csvCell(r.malpractice_expires_at),
        csvCell(r.board_cert_expires_at),
        csvCell(r.provider_status),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
