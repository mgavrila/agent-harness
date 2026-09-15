import { PDFDocument } from 'pdf-lib';
import { ToolError } from '../registry.js';
import { isRestrictedName } from '../tools/providers.js';
import { mappingLabel, type TemplateMapping } from './templates.js';

/** Everything a template or a roster may read about one provider. */
export interface ProviderData {
  provider: { name: string; npi: string | null; status: string };
  fields: { name: string; value: string | null; restricted: boolean; status: string }[];
  credentials: {
    kind: string;
    issuer: string | null;
    state: string | null;
    issuedAt: string | null;
    expiresAt: string | null;
  }[];
}

export interface ResolvedMapping {
  pdf_field: string;
  label: string;
  required: boolean;
  value: string | null;
  /** Why there is no value: the field awaits a human, or there is no record at all. */
  blocked: 'pending' | 'missing' | null;
}

/** Only a field a model extracted confidently or a human confirmed may reach a form. */
const USABLE_FIELD_STATUSES = new Set(['extracted', 'verified']);

/** The credential of a kind that a form should quote: the one that expires last. */
function latestCredential(data: ProviderData, kind: string): ProviderData['credentials'][number] | undefined {
  const matching = data.credentials.filter((c) => c.kind === kind);
  if (matching.length === 0) return undefined;
  return matching.reduce((best, c) => ((c.expiresAt ?? '') > (best.expiresAt ?? '') ? c : best));
}

function present(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value.trim() !== '' ? value : null;
}

/**
 * Turn each mapping into a value or a reason there is none. A mapping that
 * names a restricted identifier is not "blocked" but an error: a template that
 * asks for one is misconfigured, and no provider's data should make it fillable.
 */
export function resolveMappings(mappings: TemplateMapping[], data: ProviderData): ResolvedMapping[] {
  return mappings.map((m): ResolvedMapping => {
    const label = mappingLabel(m);
    const base = { pdf_field: m.pdf_field, label, required: m.required };

    if (m.source === 'provider') {
      const value = present(m.property === 'name' ? data.provider.name : data.provider.npi);
      return { ...base, value, blocked: value ? null : 'missing' };
    }

    if (m.source === 'field') {
      if (isRestrictedName(m.name)) {
        throw new ToolError(`form template maps the restricted identifier ${label}; restricted values are never printed on a form`);
      }
      const row = data.fields.find((f) => f.name === m.name);
      if (!row) return { ...base, value: null, blocked: 'missing' };
      if (row.restricted) {
        throw new ToolError(`form template maps ${label}, which is stored as a restricted value and is never printed on a form`);
      }
      if (!USABLE_FIELD_STATUSES.has(row.status)) return { ...base, value: null, blocked: 'pending' };
      const value = present(row.value);
      return { ...base, value, blocked: value ? null : 'missing' };
    }

    const credential = latestCredential(data, m.kind);
    if (!credential) return { ...base, value: null, blocked: 'missing' };
    const raw =
      m.property === 'issuer' ? credential.issuer
      : m.property === 'state' ? credential.state
      : m.property === 'issued_at' ? credential.issuedAt
      : credential.expiresAt;
    const value = present(raw);
    return { ...base, value, blocked: value ? null : 'missing' };
  });
}

/**
 * Fill, and by default flatten, an AcroForm. Flattening is deliberate for the
 * tool path: the recipient gets a document, not an editable form whose values
 * a viewer might silently drop. `updateMetadata: false` keeps the template's
 * pinned dates, so identical inputs produce identical bytes and therefore an
 * identical file id. `flatten: false` is for tests that need to read the
 * values back with `PDFDocument.load` + `form.getTextField(...).getText()` —
 * a flattened form has no fields left to read.
 */
export async function fillTemplatePdf(
  templateBytes: Uint8Array,
  values: { pdf_field: string; value: string }[],
  options: { flatten?: boolean } = {},
): Promise<Uint8Array> {
  const { flatten = true } = options;
  const doc = await PDFDocument.load(templateBytes, { updateMetadata: false });
  const form = doc.getForm();
  const known = new Set(form.getFields().map((f) => f.getName()));
  for (const { pdf_field, value } of values) {
    if (!known.has(pdf_field)) {
      throw new ToolError(`form template has no field named "${pdf_field}"; regenerate the templates or fix templates.json`);
    }
    form.getTextField(pdf_field).setText(value);
  }
  if (flatten) form.flatten();
  return doc.save();
}
