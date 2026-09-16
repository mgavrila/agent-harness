import { describe, expect, it } from 'vitest';
import { documentTextPath } from './layout.js';

describe('documentTextPath', () => {
  it('puts the redacted text beside the document, keeping the full file name', () => {
    expect(documentTextPath('/s/incoming/a.pdf')).toBe('/s/incoming/a.pdf.redacted.txt');
    expect(documentTextPath('/s/incoming/scan')).toBe('/s/incoming/scan.redacted.txt');
  });

  it('gives two documents that differ only by extension different text paths', () => {
    // Replacing the extension collapsed these onto one file: the second
    // extraction overwrote the first while both `documents` rows pointed at it.
    expect(documentTextPath('/s/incoming/a.pdf')).not.toBe(documentTextPath('/s/incoming/a.png'));
  });
});
