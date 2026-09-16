import { describe, expect, it } from 'vitest';
import { csvCell } from './csv.js';

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
