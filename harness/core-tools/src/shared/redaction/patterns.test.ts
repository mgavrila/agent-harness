import { describe, it, expect } from 'vitest';
import { containsRestrictedPattern, isValidDea } from './patterns.js';

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

describe('containsRestrictedPattern', () => {
  it('catches the three printed shapes', () => {
    expect(containsRestrictedPattern('SSN 123-45-6789 on file')).toBe(true);
    expect(containsRestrictedPattern('EIN 12-3456789')).toBe(true);
    expect(containsRestrictedPattern('DEA AB1234563')).toBe(true);
  });

  it('is a shape guard, not an extractor: it does not check the DEA check digit', () => {
    // isValidDea rejects this one; the guard still refuses the text, because a
    // false positive on a Slack card costs a glance and a false negative leaks.
    expect(isValidDea('AB1234567')).toBe(false);
    expect(containsRestrictedPattern('DEA AB1234567')).toBe(true);
  });

  it('leaves ordinary text and a ten-digit NPI alone', () => {
    expect(containsRestrictedPattern('Renew the licence before 2026-03-01')).toBe(false);
    expect(containsRestrictedPattern('NPI 1234567893')).toBe(false);
  });
});
