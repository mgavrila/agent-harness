import { describe, it, expect } from 'vitest';
import { buildRosterCsv } from './roster.js';
import { ROSTER_COLUMNS, type RosterRow } from './types.js';

function row(over: Partial<RosterRow> = {}): RosterRow {
  return {
    payer_id: 'aetna',
    provider_name: 'Dr. Ada Reyes',
    npi: '1234567893',
    primary_specialty: 'Family Medicine',
    practice_address: '12 Elm St, Austin TX',
    license_state: 'TX',
    license_issuer: 'Texas Medical Board',
    license_expires_at: '2027-03-31',
    license_number_on_file: true,
    dea_on_file: false,
    malpractice_carrier: 'MedPro',
    malpractice_expires_at: '2027-01-15',
    board_cert_expires_at: '2029-06-30',
    provider_status: 'active',
    ...over,
  };
}

describe('buildRosterCsv', () => {
  it('writes the header in the documented order', () => {
    const csv = buildRosterCsv([row()]);
    expect(csv.split('\n')[0]).toBe(ROSTER_COLUMNS.join(','));
  });

  it('reports credential numbers as yes/no and never as a value', () => {
    const csv = buildRosterCsv([row({ license_number_on_file: true, dea_on_file: true })]);
    const line = csv.split('\n')[1];
    expect(line).toContain(',yes,yes,');
    expect(csv).not.toMatch(/\d{2}-\d{7}/);
  });

  it('ends with a single trailing newline and one line per row', () => {
    const csv = buildRosterCsv([row(), row({ provider_name: 'Dr. Two' })]);
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv.trimEnd().split('\n')).toHaveLength(3);
  });
});
