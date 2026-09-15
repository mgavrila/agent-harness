import type { PageText } from './text.js';

export type RestrictedKind = 'ssn' | 'ein' | 'dea';

export interface RedactionHit {
  kind: RestrictedKind;
  /** The plaintext match. Encrypted by the caller and never persisted or logged in the clear. */
  value: string;
  /** The placeholder left in the text, e.g. `{{ssn:1}}`. */
  token: string;
  /** The `fields.name` this value is stored under. */
  fieldName: string;
  /** 1-based page the first occurrence was on. */
  page: number;
}

export interface RedactedText {
  pages: PageText[];
  hits: RedactionHit[];
}

/**
 * SSN as it is actually printed on a form: three, two, four, separated by a
 * hyphen or a space. A bare nine-digit run is deliberately NOT matched — an NPI
 * is ten digits, a licence number can be nine, and redacting those would blank
 * out the fields the pipeline exists to read. Area 000, 666 and 900-999, group
 * 00 and serial 0000 are never issued, so they are excluded to cut false
 * positives on form templates and examples.
 */
const SSN = /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/g;

/** EIN: two digits, hyphen, seven digits. Distinct from the SSN 3-2-4 shape. */
const EIN = /\b\d{2}-\d{7}\b/g;

/**
 * DEA registration: two letters then seven digits. The shape alone matches far
 * too much (order numbers, part codes), so a candidate is only a hit when its
 * check digit is right.
 */
const DEA_SHAPE = /\b[A-Za-z]{2}\d{7}\b/g;

export function isValidDea(candidate: string): boolean {
  if (!/^[A-Za-z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  const sum = d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5]);
  return sum % 10 === d[6];
}

const CANONICAL_FIELD: Record<RestrictedKind, string> = {
  ssn: 'ssn',
  ein: 'ein',
  dea: 'dea_number',
};

/**
 * The `fields.name` a hit is stored under. The first hit of a kind gets the
 * canonical name so the healthcare pack can refer to `ssn` and `dea_number`
 * directly; a second distinct value is suffixed rather than overwriting.
 * Every name produced here satisfies `isRestrictedName` in tools/providers.ts,
 * so the value is encrypted even if a caller forgets `restricted: true`.
 */
export function fieldNameFor(kind: RestrictedKind, ordinal: number): string {
  return ordinal <= 1 ? CANONICAL_FIELD[kind] : `${CANONICAL_FIELD[kind]}_${ordinal}`;
}

interface Pattern {
  kind: RestrictedKind;
  regex: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters only for readability; the three shapes cannot overlap.
const PATTERNS: Pattern[] = [
  { kind: 'ssn', regex: SSN },
  { kind: 'ein', regex: EIN },
  { kind: 'dea', regex: DEA_SHAPE, accept: isValidDea },
];

/**
 * Replace every restricted identifier with a stable token and hand the
 * plaintext back to the caller. This runs before anything is written to disk or
 * sent to a model: the redacted pages are what get persisted and prompted, and
 * `hits` are encrypted straight onto the provider record.
 *
 * The same value found twice gets the same token, so a form that repeats an SSN
 * in a header and a signature block still yields one field.
 */
export function redactPages(pages: PageText[]): RedactedText {
  // kind -> value -> assigned ordinal, so numbering is stable across pages.
  const seen = new Map<RestrictedKind, Map<string, number>>();
  const hits: RedactionHit[] = [];

  const redactedPages = pages.map((page) => {
    let text = page.text;
    for (const { kind, regex, accept } of PATTERNS) {
      // Fresh RegExp per page: the module-level literals carry /g lastIndex.
      text = text.replace(new RegExp(regex.source, regex.flags), (match) => {
        if (accept && !accept(match)) return match;
        const byValue = seen.get(kind) ?? new Map<string, number>();
        seen.set(kind, byValue);
        let ordinal = byValue.get(match);
        if (ordinal === undefined) {
          ordinal = byValue.size + 1;
          byValue.set(match, ordinal);
          hits.push({
            kind,
            value: match,
            token: `{{${kind}:${ordinal}}}`,
            fieldName: fieldNameFor(kind, ordinal),
            page: page.num,
          });
        }
        return `{{${kind}:${ordinal}}}`;
      });
    }
    return { num: page.num, text };
  });

  return { pages: redactedPages, hits };
}

/**
 * The last gate before a prompt leaves the process. A plain `Error`, not a
 * `ToolError`: this failure means the redaction pass has a hole, the message
 * must not be shown to the agent, and it deliberately names only the kind so
 * the value itself is never copied into a log or an audit row.
 */
export function assertRedacted(text: string): void {
  for (const { kind, regex, accept } of PATTERNS) {
    const matches = text.match(new RegExp(regex.source, regex.flags)) ?? [];
    if (matches.some((m) => !accept || accept(m))) {
      throw new Error(`refusing to send text to a model: a ${kind} value is not redacted`);
    }
  }
}
