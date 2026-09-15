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
