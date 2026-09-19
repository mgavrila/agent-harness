/**
 * Every pattern that recognises a restricted identifier, in one module, in two tiers. The
 * tiers are deliberate and must not be merged.
 *
 *   SHAPE_PATTERNS / containsRestrictedPattern
 *     Three strict-digit shapes, no validity gate. This is the LAST line of defence on text
 *     about to reach a human: an approval card, a decision note, a staged message. It
 *     over-reports on purpose, because a false positive costs an approver one look at the
 *     audit log and a false negative puts an SSN in a channel.
 *
 *   RESTRICTED_PATTERNS
 *     OCR-tolerant and gated on real validity rules (SSA allocation, the DEA check digit).
 *     This is what decides whether a value gets ENCRYPTED ONTO a record, where a false
 *     positive fabricates an identifier that was never on the page.
 *
 * Collapsing them into one list changes behaviour in both directions: a shape-only
 * `AB1234567` would stop tripping the human-channel guard, and an OCR-noisy `O12-34-5678` would
 * start tripping it.
 */
import { ToolError } from '@harness/shared';

export type RestrictedKind = 'ssn' | 'ein' | 'dea';

/**
 * Shapes a restricted identifier takes in free text, matched on shape alone. Not anchored to
 * a validity rule, and not OCR-tolerant: this is a guard, not an extractor.
 */
const SHAPE_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number
  /\b\d{2}-\d{7}\b/, // employer identification number
  /\b[A-Za-z]{2}\d{7}\b/, // DEA registration
];

/** True when `text` looks like it carries a restricted identifier. Cheap, and over-reports. */
export function containsRestrictedPattern(text: string): boolean {
  return SHAPE_PATTERNS.some((re) => re.test(text));
}

/**
 * What text becomes when it fails the check above on its way out of the harness (invariant 10):
 * the replacement, never the value, and never a partially masked version of it either.
 *
 * The host keeps a byte-identical copy for the messages it stores and posts, and the approvals
 * app a third for the decision notes it renders. They are separate constants on purpose — each
 * of those packages applies the rule at its own edge — but the sentence a human reads has to be
 * one sentence, so a change here is a change in all three.
 */
export const WITHHELD = '(withheld: it did not pass the redaction check)';

/**
 * Replace each restricted shape in `text` with `WITHHELD` and say how many were replaced.
 *
 * The other way to apply the rule is the host's: one shape anywhere and the whole message becomes
 * the sentence. That is right for a message, which is one thing a person either reads or does
 * not. It is wrong for a page of a document, because the check is shape-only and over-reports by
 * design — the DEA shape is any two letters followed by seven digits, which is also a form code,
 * a claim number and half the reference numbers ever printed — so blanking wholesale loses the
 * pages that were asked for on one false positive, and the caller cannot tell that from a page
 * whose text really is that sentence.
 *
 * The count is what closes that gap: a caller reading `withheld: 0` knows it has the page, and
 * one reading `withheld: 2` knows exactly how much of it is missing. `WITHHELD` carries no digit
 * and no two-letter-then-seven-digit run, so replacing one shape cannot manufacture another for
 * the next pattern in the list to find.
 */
export function withholdRestrictedPatterns(text: string): { text: string; withheld: number } {
  let withheld = 0;
  let out = text;
  for (const re of SHAPE_PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), () => {
      withheld += 1;
      return WITHHELD;
    });
  }
  return { text: out, withheld };
}

/**
 * Refuse an agent-supplied argument that looks like a restricted identifier, in the one wording
 * every staging tool uses.
 *
 * Every argument staged onto an effect needs this, not only the one that carries the prose. An
 * addressing argument is agent-chosen too, and it is validated as a *shape* — a conversation id
 * may be any of `123-45-6789`, `12-3456789` or `ab1234567` as far as the kernel can tell, because
 * the kernel cannot know a surface's id format. Those arguments are stored in plaintext and an
 * adapter that rejects one writes it into `tool_effects.last_error`, which is plaintext too, so
 * the guard belongs before the row is written rather than after.
 *
 * `what` names the argument as the agent knows it, and goes in front of the shared sentence.
 */
export function assertNoRestrictedPattern(value: string | null | undefined, what: string): void {
  if (value !== null && value !== undefined && containsRestrictedPattern(value)) {
    throw new ToolError(
      `${what} refused: it looks like it contains a restricted identifier; restricted values never leave the harness`,
    );
  }
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
 * have a clean candidate (the synthetic corpus generator, the tests) get an
 * exact answer with no OCR tolerance baked in. */
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

export interface RestrictedPattern {
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
export const RESTRICTED_PATTERNS: RestrictedPattern[] = [
  // `123-45-6789` and `123456789` are the same SSN, so both collapse to the
  // digits. A DEA number's two-letter prefix is part of the identifier, so its
  // identity is the whole normalized value.
  { kind: 'ssn', regex: SSN_FORMATTED, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ssn', regex: SSN_BARE, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ein', regex: EIN_FORMATTED, toValue: ssnOrEinValue, accept: () => true, identity: digitsOnly },
  { kind: 'dea', regex: DEA_SHAPE, toValue: deaValue, accept: deaAccept, identity: (v) => v.toUpperCase() },
];
