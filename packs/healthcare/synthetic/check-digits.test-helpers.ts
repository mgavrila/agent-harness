/**
 * Independent check-digit validators for the identifiers `rng.ts` generates.
 *
 * Deliberately a second implementation rather than a reuse of the generator's
 * own arithmetic: a test that checked `luhnNpi` with `luhnNpi`'s own sum would
 * pass however wrong that sum was. `@harness/core-tools` ships an `isValidDea`
 * for the redaction pass, and this file does not import it — a pack may depend
 * on `@harness/pack-api` and `@harness/shared` only.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and
 * the "no test imported by production" architecture rule matches on the name.
 */

/** True when a DEA registration's last digit is the checksum the DEA specifies. */
export function isValidDea(candidate: string): boolean {
  if (!/^[A-Z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  return (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}

/** True when an NPI's tenth digit is the Luhn check digit over `"80840"` plus the first nine. */
export function isValidNpi(candidate: string): boolean {
  if (!/^\d{10}$/.test(candidate)) return false;
  const digits = `80840${candidate.slice(0, 9)}`.split('').map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return (10 - (sum % 10)) % 10 === Number(candidate[9]);
}
