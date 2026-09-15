import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { credentials, fields } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef, type ToolDeps } from '../registry.js';
import { writeOutFile } from '../storage.js';
import { getTemplate, loadManifest, mappingLabel } from '../forms/templates.js';
import { fillTemplatePdf, resolveMappings, type ProviderData } from '../forms/fill.js';
import { requireProvider } from './providers.js';

/** Read everything a template may need about one provider, scoped to the client. */
export async function loadProviderData(deps: ToolDeps, providerId: string): Promise<ProviderData> {
  const provider = await requireProvider(deps, providerId);
  const fieldRows = await deps.db.select().from(fields).where(eq(fields.providerId, providerId));
  const credentialRows = await deps.db.select().from(credentials).where(eq(credentials.providerId, providerId));
  return {
    provider: { name: provider.name, npi: provider.npi, status: provider.status },
    fields: fieldRows.map((f) => ({ name: f.name, value: f.value, restricted: f.restricted, status: f.status })),
    credentials: credentialRows.map((c) => ({
      kind: c.kind,
      issuer: c.issuer,
      state: c.state,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    })),
  };
}

const formsListTemplates = defineTool({
  name: 'forms_list_templates',
  description: 'List the form templates installed for this client, with the record fields each one requires.',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({
    templates: z.array(
      z.object({ id: z.string(), title: z.string(), required_inputs: z.array(z.string()), optional_inputs: z.array(z.string()) }),
    ),
  }),
  handler: async (_args, deps) => {
    const manifest = await loadManifest(deps.formsDir);
    return {
      templates: manifest.templates.map((t) => ({
        id: t.id,
        title: t.title,
        required_inputs: t.mappings.filter((m) => m.required).map(mappingLabel),
        optional_inputs: t.mappings.filter((m) => !m.required).map(mappingLabel),
      })),
    };
  },
});

const formsFill = defineTool({
  name: 'forms_fill',
  description:
    'Fill a form template for one provider and write the PDF to the output store. Returns a file id; it sends nothing. ' +
    'Refuses when a required field is still pending human confirmation, and never prints a restricted identifier. ' +
    'Use forms_release to send the file, which needs an approval.',
  actionClass: 'write.internal',
  input: z.object({
    template_id: z.string().min(1).max(100),
    provider_id: z.string().uuid(),
  }),
  output: z.object({
    file_id: z.string(),
    bytes: z.number(),
    template_id: z.string(),
    provider_id: z.string(),
    filled: z.array(z.string()),
    left_blank: z.array(z.string()),
  }),
  handler: async ({ template_id, provider_id }, deps) => {
    const template = await getTemplate(template_id, deps.formsDir);
    const data = await loadProviderData(deps, provider_id);
    const resolved = resolveMappings(template.mappings, data);

    const blockers = resolved.filter((r) => r.required && r.blocked !== null);
    if (blockers.length > 0) {
      const pending = blockers.filter((r) => r.blocked === 'pending').map((r) => r.label);
      const missing = blockers.filter((r) => r.blocked === 'missing').map((r) => r.label);
      const parts: string[] = [];
      if (pending.length > 0) parts.push(`pending human confirmation: ${pending.join(', ')}`);
      if (missing.length > 0) parts.push(`missing from the record: ${missing.join(', ')}`);
      throw new ToolError(`cannot fill ${template_id}: ${parts.join('; ')}`);
    }

    const templateBytes = await readFile(path.join(deps.formsDir, template.file));
    const filled = resolved.filter((r) => r.value !== null);
    const bytes = await fillTemplatePdf(
      templateBytes,
      filled.map((r) => ({ pdf_field: r.pdf_field, value: r.value as string })),
    );
    const written = await writeOutFile({ dir: 'forms', name: template_id, ext: 'pdf', bytes }, deps.storageDir);

    return {
      file_id: written.file_id,
      bytes: written.bytes,
      template_id,
      provider_id,
      filled: filled.map((r) => r.label),
      left_blank: resolved.filter((r) => r.value === null).map((r) => r.label),
    };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

export const formTools: AnyToolDef[] = [formsListTemplates, formsFill];
