import { describe, it, expect } from 'vitest';
import { isValidDea, isValidNpi } from './check-digits.test-helpers.js';
import { deaNumber, luhnNpi } from './rng.js';

describe('identifier generators', () => {
  it('produces NPIs that pass the NPI check digit', () => {
    let rng = 0;
    const next = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i += 1) expect(isValidNpi(luhnNpi(next))).toBe(true);
  });

  it('produces DEA numbers that pass the DEA check digit', () => {
    let rng = 7;
    const next = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i += 1) expect(isValidDea(deaNumber(next, 'L'))).toBe(true);
  });
});
