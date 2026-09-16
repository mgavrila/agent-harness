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
