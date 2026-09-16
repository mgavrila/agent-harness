import { csvCell } from '@harness/shared';
import { ROSTER_COLUMNS, type RosterRow } from './types.js';

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
