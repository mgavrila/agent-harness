/** mulberry32: small, fast, and identical across Node versions, so a seed reproduces a corpus exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
export const digits = (rng: () => number, n: number): string =>
  Array.from({ length: n }, () => String(Math.floor(rng() * 10))).join('');

/** A ten-digit NPI whose check digit satisfies Luhn over the "80840" prefix, as CMS specifies. */
export function luhnNpi(rng: () => number): string {
  const body = digits(rng, 9);
  const withPrefix = `80840${body}`.split('').map(Number).reverse();
  const sum = withPrefix.reduce((acc, d, i) => {
    if (i % 2 !== 0) return acc + d;
    const doubled = d * 2;
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** A DEA registration whose check digit is right, so the redaction pass recognises it. */
export function deaNumber(rng: () => number, lastInitial: string): string {
  const registrant = pick(rng, ['A', 'B', 'F', 'M']);
  const six = digits(rng, 6).split('').map(Number);
  const check = (six[0] + six[2] + six[4] + 2 * (six[1] + six[3] + six[5])) % 10;
  return `${registrant}${lastInitial.toUpperCase()}${six.join('')}${check}`;
}

/** An SSN in a range the Social Security Administration actually issues, so the redaction regex sees it. */
export function ssn(rng: () => number): string {
  const area = 100 + Math.floor(rng() * 565); // 100-664, skipping 000, 666 and 9xx
  const group = 1 + Math.floor(rng() * 99);
  const serial = 1 + Math.floor(rng() * 9999);
  return `${String(area).padStart(3, '0')}-${String(group).padStart(2, '0')}-${String(serial).padStart(4, '0')}`;
}
