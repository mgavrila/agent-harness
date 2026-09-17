import type { ResolvedTarget } from '../packs/types.js';
import type { ExtractedAttachment, ExtractedField, ParsedExtraction } from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_STATE = /^[A-Z]{2}$/;

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, n));
}

function pageOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Turn a model reply into rows we are willing to store. The schema constrains
 * the shape; this constrains the meaning. Three rules do the work:
 *
 * - An empty value is an absent value, not a field worth a `pending` row.
 * - A field the target's record kind marks restricted is dropped even if the
 *   model returned one. It was never in the schema, so its presence means the
 *   model invented it, and inventing an SSN is exactly the value we must not
 *   store from a model.
 * - An attachment whose kind declares an expiry date, but whose entry carries
 *   no usable one, is dropped: `deadlines_compute` would have nothing to do
 *   with it, and an attachment row with no dates is noise a human then has to
 *   clear. A kind that declares no `expires_at` property is a different thing —
 *   a link to a ticket does not lapse — and is kept without one, which is what
 *   stops the kernel assuming that everything hung off a record is a permit
 *   with a renewal date.
 *
 * The attachment list is read from the property the target's `attachments_key`
 * names, because that is the property the model was asked for.
 */
export function parseExtraction(raw: unknown, target: ResolvedTarget): ParsedExtraction {
  if (typeof raw !== 'object' || raw === null) throw new Error('extraction reply is not an object');
  const reply = raw as Record<string, unknown>;
  if (typeof reply.document_kind !== 'string') throw new Error('extraction reply has no document_kind');

  // The owning pack's kinds, not every loaded pack's: a reply naming a kind some *other* pack
  // declares is not a kind this extraction can have produced, so it falls back like any other
  // unrecognised string.
  const documentKind = target.pack.documentKinds.includes(reply.document_kind) ? reply.document_kind : 'other';

  const allowed = new Map(target.recordKind.fields.filter((f) => f.source === 'model').map((f) => [f.name, f]));
  const rawFields = (typeof reply.fields === 'object' && reply.fields !== null ? reply.fields : {}) as Record<
    string,
    unknown
  >;

  const fields: ExtractedField[] = [];
  for (const [name, slot] of Object.entries(rawFields)) {
    if (!allowed.has(name)) continue;
    if (typeof slot !== 'object' || slot === null) continue;
    const s = slot as Record<string, unknown>;
    const value = textOrUndefined(s.value);
    if (value === undefined) continue;
    fields.push({
      name,
      value,
      confidence: clampConfidence(s.confidence),
      source_page: pageOrUndefined(s.source_page),
    });
  }
  fields.sort((a, b) => a.name.localeCompare(b.name));

  // Per kind, not one set: whether an entry needs an expiry date is the kind's own declaration.
  const kinds = new Map(target.attachmentKinds.map((a) => [a.kind, a]));
  const rawList = reply[target.target.attachments_key];
  const rawAttachments = Array.isArray(rawList) ? rawList : [];
  const attachments: ExtractedAttachment[] = [];
  for (const entry of rawAttachments) {
    if (typeof entry !== 'object' || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.kind !== 'string') continue;
    const kind = kinds.get(c.kind);
    if (!kind) continue;
    const issuedAt = textOrUndefined(c.issued_at);
    const expiresAt = textOrUndefined(c.expires_at);
    const dated = expiresAt !== undefined && ISO_DATE.test(expiresAt);
    if (!dated && kind.properties.includes('expires_at')) continue;
    const state = textOrUndefined(c.state)?.toUpperCase();
    attachments.push({
      kind: c.kind,
      issuer: textOrUndefined(c.issuer),
      state: state !== undefined && US_STATE.test(state) ? state : undefined,
      issued_at: issuedAt !== undefined && ISO_DATE.test(issuedAt) ? issuedAt : undefined,
      expires_at: dated ? expiresAt : undefined,
      confidence: clampConfidence(c.confidence),
      source_page: pageOrUndefined(c.source_page),
    });
  }

  return { documentKind, fields, attachments };
}
