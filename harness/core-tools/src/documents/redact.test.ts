import { describe, it, expect } from 'vitest';
import { assertRedacted, fieldNameFor, isValidDea, redactPages } from './redact.js';

describe('isValidDea', () => {
  // DEA check digit: (d1+d3+d5) + 2*(d2+d4+d6), last digit must equal d7.
  it('accepts numbers whose check digit is right', () => {
    expect(isValidDea('BL1234563')).toBe(true); //  9 + 24 = 33 -> 3
    expect(isValidDea('FD9876547')).toBe(true); // 21 + 36 = 57 -> 7
  });

  it('rejects a wrong check digit', () => {
    expect(isValidDea('BL1234567')).toBe(false);
    expect(isValidDea('FD9876543')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    expect(isValidDea('B1234563')).toBe(false);
    expect(isValidDea('BL123456')).toBe(false);
    expect(isValidDea('BL12345633')).toBe(false);
  });
});

describe('redactPages', () => {
  it('replaces an SSN with a token and reports the plaintext hit', () => {
    const out = redactPages([{ num: 1, text: 'Name: Ada\nSSN: 123-45-6789\n' }]);
    expect(out.pages[0].text).toBe('Name: Ada\nSSN: {{ssn:1}}\n');
    expect(out.hits).toEqual([
      { kind: 'ssn', value: '123-45-6789', token: '{{ssn:1}}', fieldName: 'ssn', page: 1 },
    ]);
  });

  it('replaces an EIN and a valid DEA number', () => {
    const out = redactPages([{ num: 1, text: 'EIN 12-3456789 and DEA BL1234563.' }]);
    expect(out.pages[0].text).toBe('EIN {{ein:1}} and DEA {{dea:1}}.');
    expect(out.hits.map((h) => h.kind)).toEqual(['ein', 'dea']);
    expect(out.hits.map((h) => h.fieldName)).toEqual(['ein', 'dea_number']);
  });

  it('leaves a DEA-shaped string with a bad check digit alone', () => {
    const out = redactPages([{ num: 1, text: 'Order AB1234567 shipped.' }]);
    expect(out.pages[0].text).toBe('Order AB1234567 shipped.');
    expect(out.hits).toHaveLength(0);
  });

  it('numbers repeated hits of the same kind and keeps one token per distinct value', () => {
    const out = redactPages([
      { num: 1, text: 'SSN 123-45-6789 appears twice: 123-45-6789' },
      { num: 2, text: 'Spouse SSN 321-65-4321' },
    ]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}} appears twice: {{ssn:1}}');
    expect(out.pages[1].text).toBe('Spouse SSN {{ssn:2}}');
    expect(out.hits.map((h) => h.fieldName)).toEqual(['ssn', 'ssn_2']);
    expect(out.hits.map((h) => h.page)).toEqual([1, 2]);
  });

  it('does not redact SSN area codes 000, 666 or 900-999', () => {
    const text = 'A 000-12-3456 B 666-12-3456 C 987-65-4321';
    const out = redactPages([{ num: 1, text }]);
    expect(out.pages[0].text).toBe(text);
    expect(out.hits).toHaveLength(0);
  });

  it('does not redact an SSN with group 00 or serial 0000', () => {
    const text = 'D 123-00-4567 E 123-45-0000';
    const out = redactPages([{ num: 1, text }]);
    expect(out.pages[0].text).toBe(text);
    expect(out.hits).toHaveLength(0);
  });

  it('does not touch an NPI, a phone number, a date or a licence number', () => {
    const text = 'NPI 1234567890, phone 415-555-0100, issued 2026-09-15, licence A98765, zip 94110-1234';
    const out = redactPages([{ num: 1, text }]);
    expect(out.pages[0].text).toBe(text);
    expect(out.hits).toHaveLength(0);
  });

  it('handles an SSN written with spaces', () => {
    const out = redactPages([{ num: 1, text: 'SSN 123 45 6789' }]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}}');
    expect(out.hits[0].value).toBe('123 45 6789');
  });

  it('returns pages unchanged when there is nothing to redact', () => {
    const pages = [{ num: 1, text: 'Nothing here.' }];
    const out = redactPages(pages);
    expect(out.pages).toEqual(pages);
    expect(out.hits).toEqual([]);
  });

  it('redacts a bare nine-digit SSN with no punctuation', () => {
    const out = redactPages([{ num: 1, text: 'SSN 123456789 filed' }]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}} filed');
    expect(out.hits).toEqual([
      { kind: 'ssn', value: '123456789', token: '{{ssn:1}}', fieldName: 'ssn', page: 1 },
    ]);
  });

  it('does not redact nine bare digits that are part of a longer, ten-digit NPI', () => {
    const out = redactPages([{ num: 1, text: 'NPI 1234567893' }]);
    expect(out.pages[0].text).toBe('NPI 1234567893');
    expect(out.hits).toHaveLength(0);
  });

  it('does not redact nine bare digits with an excluded SSA area code', () => {
    const out = redactPages([{ num: 1, text: 'Ref 900123456' }]);
    expect(out.pages[0].text).toBe('Ref 900123456');
    expect(out.hits).toHaveLength(0);
  });

  it('normalizes an OCR-confused letter O to 0 in an SSN and redacts it', () => {
    const out = redactPages([{ num: 1, text: 'SSN 123-45-678O' }]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}}');
    expect(out.hits[0].value).toBe('123-45-6780');
  });

  it('normalizes OCR noise before validating a DEA check digit, and rejects it if it still fails', () => {
    // 'I' normalizes to '1'; the resulting digits are BL1234567, the same
    // wrong-check-digit number as "rejects a wrong check digit" above. This
    // proves normalization ran before validation, not that OCR tolerance
    // makes every noisy candidate a hit.
    const out = redactPages([{ num: 1, text: 'DEA BLI234567 shipped' }]);
    expect(out.pages[0].text).toBe('DEA BLI234567 shipped');
    expect(out.hits).toHaveLength(0);
  });

  it('does not treat a non-Latin look-alike digit as OCR noise', () => {
    const out = redactPages([{ num: 1, text: 'DEA BL123456З shipped' }]);
    expect(out.pages[0].text).toBe('DEA BL123456З shipped');
    expect(out.hits).toHaveLength(0);
  });

  it('joins an SSN split across a line break between groups', () => {
    const out = redactPages([{ num: 1, text: 'SSN 123-45-\n6789 on file' }]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}} on file');
    expect(out.hits[0].value).toBe('123456789');
  });

  it('joins an EIN split across a line break between groups', () => {
    const out = redactPages([{ num: 1, text: 'EIN 12-\n3456789 filed' }]);
    expect(out.pages[0].text).toBe('EIN {{ein:1}} filed');
    expect(out.hits[0].value).toBe('123456789');
  });

  it('joins an SSN whose second separator alone is a bare line break', () => {
    const out = redactPages([{ num: 1, text: 'SSN 123-45\n6789 on file' }]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}} on file');
    expect(out.hits[0].value).toBe('123456789');
  });

  it('gives the formatted and bare encodings of one SSN a single token and field', () => {
    const out = redactPages([
      { num: 1, text: 'SSN 123-45-6789 in the header' },
      { num: 2, text: 'Typed into the form field: 123456789' },
    ]);
    expect(out.pages[0].text).toBe('SSN {{ssn:1}} in the header');
    expect(out.pages[1].text).toBe('Typed into the form field: {{ssn:1}}');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].fieldName).toBe('ssn');
  });

  it('does not treat a column of unpunctuated numbers as an SSN', () => {
    // Three lines of 3, 2 and 4 digits with no printed separator at either
    // slot is a column of figures, not a wrapped SSN field. Redacting it
    // would destroy three real values AND write the fabricated number
    // 123456789 onto the provider record as an encrypted `ssn`.
    const text = 'Claims history\n123\n45\n6789\n';
    const out = redactPages([{ num: 1, text }]);
    expect(out.pages[0].text).toBe(text);
    expect(out.hits).toHaveLength(0);
    expect(() => assertRedacted(text)).not.toThrow();
  });
});

describe('fieldNameFor', () => {
  it('uses the canonical field name for the first hit of a kind', () => {
    expect(fieldNameFor('ssn', 1)).toBe('ssn');
    expect(fieldNameFor('ein', 1)).toBe('ein');
    expect(fieldNameFor('dea', 1)).toBe('dea_number');
  });

  it('suffixes later hits', () => {
    expect(fieldNameFor('ssn', 3)).toBe('ssn_3');
    expect(fieldNameFor('dea', 2)).toBe('dea_number_2');
  });

  it('produces names the providers toolset treats as restricted', async () => {
    const { isRestrictedName } = await import('../tools/providers.js');
    expect(isRestrictedName(fieldNameFor('ssn', 1))).toBe(true);
    expect(isRestrictedName(fieldNameFor('ein', 1))).toBe(true);
    expect(isRestrictedName(fieldNameFor('dea', 1))).toBe(true);
  });
});

describe('assertRedacted', () => {
  it('passes for redacted text', () => {
    expect(() => assertRedacted('SSN {{ssn:1}} DEA {{dea:1}}')).not.toThrow();
  });

  it('throws when a restricted pattern survives', () => {
    expect(() => assertRedacted('SSN 123-45-6789')).toThrow(/not redacted/);
    expect(() => assertRedacted('DEA BL1234563')).toThrow(/not redacted/);
  });

  it('throws on a bare nine-digit SSN', () => {
    expect(() => assertRedacted('SSN 123456789')).toThrow(/not redacted/);
  });

  it('throws on an OCR-confused SSN that a strict scan would miss', () => {
    expect(() => assertRedacted('SSN 123-45-678O')).toThrow(/not redacted/);
  });

  it('throws on an SSN split across a line break', () => {
    expect(() => assertRedacted('SSN 123-45-\n6789')).toThrow(/not redacted/);
  });

  it('never quotes the value it found', () => {
    const err = (() => {
      try {
        assertRedacted('SSN 123-45-6789');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain('123-45-6789');
  });
});
