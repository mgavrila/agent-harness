import type { ProviderManifest } from './manifest.js';
import type { ExtractedCredential, ExtractedField, ParsedExtraction } from './types.js';

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
 * - A field the manifest marks restricted is dropped even if the model returned
 *   one. It was never in the schema, so its presence means the model invented
 *   it, and inventing an SSN is exactly the value we must not store from a model.
 * - A credential with no usable expiry date is dropped: `deadlines_compute`
 *   would have nothing to do with it, and a credential row with no dates is
 *   noise a human then has to clear.
 */
export function parseExtraction(raw: unknown, manifest: ProviderManifest): ParsedExtraction {
  if (typeof raw !== 'object' || raw === null) throw new Error('extraction reply is not an object');
  const reply = raw as Record<string, unknown>;
  if (typeof reply.document_kind !== 'string') throw new Error('extraction reply has no document_kind');

  const documentKind = manifest.document_kinds.includes(reply.document_kind) ? reply.document_kind : 'other';

  const allowed = new Map(manifest.fields.filter((f) => f.source === 'model').map((f) => [f.name, f]));
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

  const kinds = new Set(manifest.credentials.map((c) => c.kind));
  const rawCredentials = Array.isArray(reply.credentials) ? reply.credentials : [];
  const credentials: ExtractedCredential[] = [];
  for (const entry of rawCredentials) {
    if (typeof entry !== 'object' || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.kind !== 'string' || !kinds.has(c.kind as ExtractedCredential['kind'])) continue;
    const issuedAt = textOrUndefined(c.issued_at);
    const expiresAt = textOrUndefined(c.expires_at);
    if (expiresAt === undefined || !ISO_DATE.test(expiresAt)) continue;
    const state = textOrUndefined(c.state)?.toUpperCase();
    credentials.push({
      kind: c.kind as ExtractedCredential['kind'],
      issuer: textOrUndefined(c.issuer),
      state: state !== undefined && US_STATE.test(state) ? state : undefined,
      issued_at: issuedAt !== undefined && ISO_DATE.test(issuedAt) ? issuedAt : undefined,
      expires_at: expiresAt,
      confidence: clampConfidence(c.confidence),
      source_page: pageOrUndefined(c.source_page),
    });
  }

  return { documentKind, fields, credentials };
}
