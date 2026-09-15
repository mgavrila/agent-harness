import { describe, it, expect } from 'vitest';
import { ROSTER_COLUMNS, csvCell, buildRosterCsv, type RosterRow } from './roster.js';

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

describe('csvCell', () => {
  it('leaves a plain value alone and empties a null', () => {
    expect(csvCell('TX')).toBe('TX');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes separators, newlines and quotes', () => {
    expect(csvCell('12 Elm St, Austin TX')).toBe('"12 Elm St, Austin TX"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('defuses a value a spreadsheet would read as a formula', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe(`"'=SUM(A1:A9)"`);
    expect(csvCell('+1 555 0100')).toBe(`"'+1 555 0100"`);
    expect(csvCell('-TX')).toBe(`'-TX`);
    expect(csvCell('@here')).toBe(`'@here`);
  });

  it('defuses a formula hidden behind leading whitespace a spreadsheet strips', () => {
    // Excel removes a leading tab, CR or space before deciding whether the
    // cell is a formula, so the leader has to be read after them.
    expect(csvCell('\t=cmd|calc')).toBe(`"'\t=cmd|calc"`);
    expect(csvCell('\r=cmd|calc')).toBe(`"'\r=cmd|calc"`);
    expect(csvCell(' =cmd|calc')).toBe(`"' =cmd|calc"`);
    expect(csvCell('\t+1 555 0100')).toBe(`"'\t+1 555 0100"`);
    expect(csvCell('\t-TX')).toBe(`'\t-TX`);
    expect(csvCell('\t@here')).toBe(`'\t@here`);
  });

  it('leaves a value that only looks like whitespace alone', () => {
    expect(csvCell('\tTX')).toBe('\tTX');
    expect(csvCell('   ')).toBe('   ');
  });
});

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
