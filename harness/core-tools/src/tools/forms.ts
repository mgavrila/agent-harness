import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { writeOutFile } from '../domain/storage/file-store.js';
import { getTemplate, loadManifest, mappingLabel } from '../domain/forms/templates.js';
import { fillTemplatePdf, resolveMappings } from '../domain/forms/fill.js';
import { buildRoster, loadProviderData } from '../domain/forms/provider-data.js';
import { stageRelease } from '../domain/files/release.js';
import { buildRosterCsv } from '../domain/forms/roster.js';
import { ROSTER_COLUMNS } from '../domain/forms/types.js';

const formsListTemplates = defineTool({
  name: 'forms_list_templates',
  description: 'List the form templates installed for this client, with the record fields each one requires.',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({
    templates: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        required_inputs: z.array(z.string()),
        optional_inputs: z.array(z.string()),
      }),
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

const formsRoster = defineTool({
  name: 'forms_roster',
  description:
    'Build a payer roster CSV for a list of providers and write it to the output store. Returns a file id; it sends nothing. ' +
    'Credential numbers are reported as on-file yes/no and never exported. Use forms_release to send it, which needs an approval.',
  actionClass: 'write.internal',
  input: z.object({
    payer_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'payer_id must be a lowercase slug'),
    provider_ids: z.array(z.string().uuid()).min(1).max(200),
  }),
  output: z.object({
    file_id: z.string(),
    bytes: z.number(),
    payer_id: z.string(),
    rows: z.number(),
    columns: z.array(z.string()),
  }),
  handler: async ({ payer_id, provider_ids }, deps) => {
    // Preserve the caller's order and drop repeats, so a roster built from a
    // search result does not list a provider twice.
    const rows = await buildRoster(deps, payer_id, [...new Set(provider_ids)]);
    const bytes = new TextEncoder().encode(buildRosterCsv(rows));
    const written = await writeOutFile({ dir: 'roster', name: payer_id, ext: 'csv', bytes }, deps.storageDir);
    return {
      file_id: written.file_id,
      bytes: written.bytes,
      payer_id,
      rows: rows.length,
      columns: [...ROSTER_COLUMNS],
    };
  },
  recordIds: (args) => [...new Set(args.provider_ids)],
});

const formsRelease = defineTool({
  name: 'forms_release',
  description:
    'Send a file that forms_fill or forms_roster produced to Slack. External: it parks an approval, and only ' +
    'approvals_execute stages the delivery. Nothing leaves the harness until a human approves.',
  actionClass: 'external',
  input: z.object({
    file_id: z.string().min(1).max(300),
    channel: z
      .string()
      .regex(/^[CGD][A-Z0-9]{2,}$/, 'channel must be a Slack channel id')
      .optional(),
  }),
  output: z.object({
    effect_id: z.string(),
    staged: z.boolean(),
    file_id: z.string(),
    filename: z.string(),
    bytes: z.number(),
  }),
  handler: async (args, deps) => stageRelease(deps, args),
});

export const formTools: AnyToolDef[] = [formsListTemplates, formsFill, formsRoster, formsRelease];
