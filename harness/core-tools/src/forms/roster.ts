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

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEADERS = ['=', '+', '-', '@'];
/** Of those, the two that are unambiguous formula starts, so a tick prefix alone is not trusted: the cell is also quoted. */
const FORCE_QUOTE_LEADERS = ['=', '+'];
/**
 * Whitespace a spreadsheet strips before it decides whether a cell is a
 * formula, so `\t=cmd|…` reaches the parser as `=cmd|…`. Looking only at
 * index 0 misses every one of these.
 */
const STRIPPED_BEFORE_PARSE = /^[\t\r\n ]+/;

/**
 * One CSV cell. Quoting follows RFC 4180; the extra single-quote prefix stops
 * a spreadsheet from evaluating a value that begins with `=`, `+`, `-` or `@`,
 * which is how a name copied out of a document becomes a formula. `=` and `+`
 * are quoted outright rather than relying on the tick alone.
 *
 * The leader is taken after leading tabs, carriage returns, newlines and
 * spaces, because a spreadsheet strips those before parsing: a cell starting
 * `\t=` is a formula to Excel and was not to this guard.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const leader = value.replace(STRIPPED_BEFORE_PARSE, '').charAt(0);
  const defused = FORMULA_LEADERS.includes(leader) ? `'${value}` : value;
  const mustQuote = FORCE_QUOTE_LEADERS.includes(leader) || /[",\n\r]/.test(defused);
  return mustQuote ? `"${defused.replaceAll('"', '""')}"` : defused;
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
