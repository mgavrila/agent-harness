import { RESTRICTED_PATTERNS, type RestrictedKind } from './patterns.js';

/**
 * A page of text, as the document pipeline produces it. Declared here rather than imported
 * from the documents domain, because `shared/` may not import a domain: redaction runs over
 * the shape `{ num, text }` and knows nothing else about a document. `PageText` in
 * `domain/documents/types.ts` is structurally identical, so a `PageText[]` passes straight in.
 */
export interface RedactablePage {
  num: number;
  text: string;
}

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
  pages: RedactablePage[];
  hits: RedactionHit[];
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
 * Every name produced here satisfies `isRestrictedName` in redaction/names.ts
 * — it strips exactly this trailing ordinal before matching — so the value is
 * encrypted even if a caller forgets `restricted: true`.
 */
export function fieldNameFor(kind: RestrictedKind, ordinal: number): string {
  return ordinal <= 1 ? CANONICAL_FIELD[kind] : `${CANONICAL_FIELD[kind]}_${ordinal}`;
}

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
export function redactPages(pages: readonly RedactablePage[]): RedactedText {
  // kind -> value identity -> assigned ordinal, so numbering is stable across pages.
  const seen = new Map<RestrictedKind, Map<string, number>>();
  const hits: RedactionHit[] = [];

  const redactedPages = pages.map((page) => {
    let text = page.text;
    for (const { kind, regex, toValue, accept, identity } of RESTRICTED_PATTERNS) {
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
  for (const { kind, regex, accept } of RESTRICTED_PATTERNS) {
    for (const m of text.matchAll(new RegExp(regex.source, regex.flags))) {
      if (accept(m[0])) {
        throw new Error(`refusing to send text to a model: a ${kind} value is not redacted`);
      }
    }
  }
}
