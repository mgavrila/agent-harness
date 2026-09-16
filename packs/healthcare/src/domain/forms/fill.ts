import { PDFDocument } from 'pdf-lib';
import { ToolError } from '@harness/shared';
import { mappingLabel } from './templates.js';
import type { ProviderData, ResolvedMapping, TemplateMapping } from './types.js';

/** Only a field a model extracted confidently or a human confirmed may reach a form. */
const USABLE_FIELD_STATUSES = new Set(['extracted', 'verified']);

/** A `credential` mapping's `property`, as the column it reads off a loaded credential. */
const CREDENTIAL_PROPERTY_COLUMNS = {
  issuer: 'issuer',
  state: 'state',
  issued_at: 'issuedAt',
  expires_at: 'expiresAt',
} as const satisfies Record<Extract<TemplateMapping, { source: 'credential' }>['property'], string>;

/**
 * The credential of a kind that a form should quote: the one that expires last.
 * Shared with the roster in provider-data.ts, which must pick the same one: two
 * copies of this rule is how a filled form and the roster built from the same
 * record come to name different licences.
 */
export function latestCredential(data: ProviderData, kind: string): ProviderData['credentials'][number] | undefined {
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
 *
 * `isRestrictedName` is a parameter because the rule belongs to whoever does the encrypting:
 * it is the kernel's, reached through `deps.kernel`, and a pack may not import it. The caller
 * in `tools/forms.ts` has the dependency bag in hand and passes it straight through.
 */
export function resolveMappings(
  mappings: TemplateMapping[],
  data: ProviderData,
  isRestrictedName: (name: string) => boolean,
): ResolvedMapping[] {
  return mappings.map((m): ResolvedMapping => {
    const label = mappingLabel(m);
    const base = { pdf_field: m.pdf_field, label, required: m.required };

    if (m.source === 'provider') {
      const value = present(m.property === 'name' ? data.provider.name : data.provider.npi);
      return { ...base, value, blocked: value ? null : 'missing' };
    }

    if (m.source === 'field') {
      if (isRestrictedName(m.name)) {
        throw new ToolError(
          `form template maps the restricted identifier ${label}; restricted values are never printed on a form`,
        );
      }
      const row = data.fields.find((f) => f.name === m.name);
      if (!row) return { ...base, value: null, blocked: 'missing' };
      if (row.restricted) {
        throw new ToolError(
          `form template maps ${label}, which is stored as a restricted value and is never printed on a form`,
        );
      }
      if (!USABLE_FIELD_STATUSES.has(row.status)) return { ...base, value: null, blocked: 'pending' };
      const value = present(row.value);
      return { ...base, value, blocked: value ? null : 'missing' };
    }

    const credential = latestCredential(data, m.kind);
    if (!credential) return { ...base, value: null, blocked: 'missing' };
    const value = present(credential[CREDENTIAL_PROPERTY_COLUMNS[m.property]]);
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
      throw new ToolError(
        `form template has no field named "${pdf_field}"; regenerate the templates or fix templates.json`,
      );
    }
    form.getTextField(pdf_field).setText(value);
  }
  if (flatten) form.flatten();
  return doc.save();
}
