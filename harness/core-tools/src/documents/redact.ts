import type { PageText } from './text.js';

export type RestrictedKind = 'ssn' | 'ein' | 'dea';

export interface RedactionHit {
  kind: RestrictedKind;
  /** The plaintext match, OCR-normalized and (for a line-break split) rejoined. Encrypted by the caller and never persisted or logged in the clear. */
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
 * A single tolerant "digit" position. OCR and bad scans routinely turn `0`
 * into the letter `O`, and `1` into `I`, lowercase `l`, or a stray `|` from a
 * broken vertical stroke. Every digit position below accepts this class
 * instead of `\d`, so a scanned form does not smuggle a restricted identifier
 * past redaction just because a character reader misread one glyph. This can
 * over-redact a string that only looks like a restricted number once OCR
 * noise is discounted; that is the intended trade-off here — under-redaction,
 * not over-redaction, is the failure this module exists to prevent.
 */
const D = '[0-9OoIl|]';

/** Replace every OCR look-alike in `s` with the digit it stands in for. Safe to
 * run over a whole match, separators included: none of `-`, ` `, `\n`, `\t`
 * are in the mapped set, so only true digit positions change. */
function normalizeOcr(s: string): string {
  return s.replace(/[OoIl|]/g, (ch) => (ch === 'O' || ch === 'o' ? '0' : '1'));
}

/** Strip everything but digits, e.g. to test SSA allocation rules or to
 * collapse a line-break-split match into one plain number. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** One line break, absorbing any indentation that follows it. */
const NL = String.raw`\n[ \t]*`;

/**
 * A separator as it is actually printed on a form: a dash or a space,
 * optionally followed by a single line break where a text layer or OCR pass
 * wrapped the field onto two lines.
 */
const SEP_PRINTED = String.raw`[- ][ \t]*(?:${NL})?`;

/**
 * Either a printed separator or a bare line break, for the case where two
 * groups landed on separate lines with no punctuation at all. The two
 * separator slots in a pattern are independent, so a form is not required to
 * use the same character twice.
 */
const SEP = String.raw`(?:${SEP_PRINTED}|${NL})`;

/**
 * SSN as it is actually printed on a form: three, two, four digits, with a
 * separator between each group (see `SEP`). Area 000, 666 and 900-999, group
 * 00 and serial 0000 are never issued; `isValidSsnDigits` below rejects them
 * to cut false positives on form templates and examples, after OCR
 * normalization and separator stripping — the shape here is intentionally
 * loose (see `D`).
 *
 * At most ONE of the two separator slots may be a bare line break: at least
 * one printed `-` or space has to be there to say "these groups belong to one
 * field". Allowing a bare break at both slots would make any three consecutive
 * unpunctuated lines of 3, 2 and 4 digits — a column of figures on a claims
 * page — an SSN, and `documents_extract` would then write that fabricated
 * nine-digit number onto the provider record as an encrypted `ssn`. A real
 * form that wraps does so at one slot, so nothing legitimate is lost.
 */
const SSN_FORMATTED = new RegExp(
  String.raw`\b${D}{3}(?:${SEP_PRINTED}${D}{2}${SEP}|${SEP}${D}{2}${SEP_PRINTED})${D}{4}\b`,
  'g',
);

/**
 * The same nine digits with no separator at all — how an SSN is typed into a
 * single form field, or how a punctuation-dropping OCR pass renders one.
 * `\b` on both ends keeps this from matching inside a longer digit run, so a
 * ten-digit NPI is left alone: a 9-character window inside a 10-digit run has
 * no boundary on its inner edge.
 */
const SSN_BARE = new RegExp(String.raw`\b${D}{9}\b`, 'g');

/** EIN: two digits, a separator, seven digits. Distinct in shape from the SSN 3-2-4 groups. */
const EIN_FORMATTED = new RegExp(String.raw`\b${D}{2}${SEP}${D}{7}\b`, 'g');

/**
 * DEA registration: two letters then seven digits. The shape alone matches far
 * too much (order numbers, part codes), so a candidate is only a hit when its
 * check digit is right. The two-letter prefix is real registrant-type
 * lettering, not a digit position, so it is never OCR-normalized: doing so
 * would corrupt a legitimate prefix that happens to contain `O` or `I`.
 */
const DEA_SHAPE = new RegExp(String.raw`\b[A-Za-z]{2}${D}{7}\b`, 'g');

/** The DEA check-digit algorithm. Strict on purpose: callers that already
 * have a clean candidate (Task 9's generator, the tests below) get an exact
 * answer with no OCR tolerance baked in. */
export function isValidDea(candidate: string): boolean {
  if (!/^[A-Za-z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  const sum = d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5]);
  return sum % 10 === d[6];
}

/** SSA allocation rules for a 9-digit SSN, applied after OCR normalization and
 * separator stripping. */
function isValidSsnDigits(nine: string): boolean {
  if (!/^\d{9}$/.test(nine)) return false;
  const area = nine.slice(0, 3);
  const group = nine.slice(3, 5);
  const serial = nine.slice(5, 9);
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

/** The value to store and to validate: OCR look-alikes replaced with digits,
 * and — only when the match crossed a line break — separators dropped
 * entirely so the stored value is the plain joined number rather than one
 * with a newline baked into it. A clean match is returned unchanged. */
function ssnOrEinValue(raw: string): string {
  const normalized = normalizeOcr(raw);
  return raw.includes('\n') ? digitsOnly(normalized) : normalized;
}

function ssnAccept(raw: string): boolean {
  return isValidSsnDigits(digitsOnly(normalizeOcr(raw)));
}

/** The two-letter prefix is left untouched; only the seven digit positions
 * that follow are OCR-normalized. */
function deaValue(raw: string): string {
  return raw.slice(0, 2) + normalizeOcr(raw.slice(2));
}

function deaAccept(raw: string): boolean {
  return isValidDea(deaValue(raw));
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
 * Every name produced here satisfies `isRestrictedName` in tools/providers.ts
 * — it strips exactly this trailing ordinal before matching — so the value is
 * encrypted even if a caller forgets `restricted: true`.
 */
export function fieldNameFor(kind: RestrictedKind, ordinal: number): string {
  return ordinal <= 1 ? CANONICAL_FIELD[kind] : `${CANONICAL_FIELD[kind]}_${ordinal}`;
}

interface Pattern {
  kind: RestrictedKind;
  regex: RegExp;
  /** Build the value to store and report from a raw regex match. */
  toValue: (raw: string) => string;
  /** Accept or reject a raw match — the shape alone is never enough. */
  accept: (raw: string) => boolean;
  /**
   * The identity of a value for token and ordinal purposes. Two matches with
   * the same identity are one value: they share a token and a field name,
   * however each was punctuated on the page.
   */
  identity: (value: string) => string;
}

// Order matters only for readability; the four shapes cannot overlap: each
// requires a separator (or a check digit) the others don't produce.
const PATTERNS: Pattern[] = [
  // `123-45-6789` and `123456789` are the same SSN, so both collapse to the
  // digits. A DEA number's two-letter prefix is part of the identifier, so its
  // identity is the whole normalized value.
  { kind: 'ssn', regex: SSN_FORMATTED, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ssn', regex: SSN_BARE, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ein', regex: EIN_FORMATTED, toValue: ssnOrEinValue, accept: () => true, identity: digitsOnly },
  { kind: 'dea', regex: DEA_SHAPE, toValue: deaValue, accept: deaAccept, identity: (v) => v.toUpperCase() },
];

/**
 * Replace every restricted identifier with a stable token and hand the
 * plaintext back to the caller. This runs before anything is written to disk or
 * sent to a model: the redacted pages are what get persisted and prompted, and
 * `hits` are encrypted straight onto the provider record.
 *
 * The same value found twice gets the same token, so a form that repeats an SSN
 * in a header and a signature block still yields one field — including when
 * one occurrence is OCR-noisy and the other is clean, and including when one
 * is written `123-45-6789` and the other `123456789`: numbering is keyed on
 * the digits, not on how the page punctuated them. One value therefore yields
 * one token and one field, never an `ssn` and an `ssn_2` holding the same
 * number.
 */
export function redactPages(pages: PageText[]): RedactedText {
  // kind -> value identity -> assigned ordinal, so numbering is stable across pages.
  const seen = new Map<RestrictedKind, Map<string, number>>();
  const hits: RedactionHit[] = [];

  const redactedPages = pages.map((page) => {
    let text = page.text;
    for (const { kind, regex, toValue, accept, identity } of PATTERNS) {
      // Fresh RegExp per page: the module-level literals carry /g lastIndex.
      text = text.replace(new RegExp(regex.source, regex.flags), (match) => {
        if (!accept(match)) return match;
        const value = toValue(match);
        const key = identity(value);
        const byValue = seen.get(kind) ?? new Map<string, number>();
        seen.set(kind, byValue);
        let ordinal = byValue.get(key);
        if (ordinal === undefined) {
          ordinal = byValue.size + 1;
          byValue.set(key, ordinal);
          hits.push({
            kind,
            value,
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
 * the value itself is never copied into a log or an audit row. Scans with the
 * same OCR- and line-break-tolerant patterns as `redactPages`, so text that
 * would survive redaction is caught here too.
 */
export function assertRedacted(text: string): void {
  for (const { kind, regex, accept } of PATTERNS) {
    for (const m of text.matchAll(new RegExp(regex.source, regex.flags))) {
      if (accept(m[0])) {
        throw new Error(`refusing to send text to a model: a ${kind} value is not redacted`);
      }
    }
  }
}
