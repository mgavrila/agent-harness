import { describe, it, expect } from 'vitest';
import { deaNumber, luhnNpi } from './rng.js';

function isValidDea(candidate: string): boolean {
  if (!/^[A-Z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  return (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}

function isValidNpi(candidate: string): boolean {
  if (!/^\d{10}$/.test(candidate)) return false;
  // NPI check digit: Luhn over "80840" + the first nine digits.
  const digits = `80840${candidate.slice(0, 9)}`.split('').map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return (10 - (sum % 10)) % 10 === Number(candidate[9]);
}

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
