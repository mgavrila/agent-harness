const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);
const SUFFIXES = new Set(['md', 'do', 'dds', 'dmd', 'np', 'pa', 'rn', 'lcsw', 'phd', 'jr', 'sr', 'ii', 'iii', 'iv']);

/**
 * Whether two renderings of a person's name are the same person. NPPES prints
 * uppercase with the middle name always present; intake forms print titles,
 * degree suffixes, commas and sometimes "Last, First". Comparing the remaining
 * name tokens as a set handles all three without a name-parsing library.
 *
 * It is deliberately permissive: this feeds a flag a human reads, and a false
 * mismatch that sends someone to re-key a correct record costs more than a
 * false match that a reviewer catches next to the registry name we also return.
 */
export function namesMatch(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t !== '' && !TITLES.has(t) && !SUFFIXES.has(t)),
    );
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return false;
  // A middle name present on one side only must not break the match, so the
  // smaller set has to be wholly contained in the larger.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  return true;
}
