import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
import { definePackTool, type AnyToolDef } from '@harness/pack-api';
import { getTemplate, loadManifest, mappingLabel } from '../domain/forms/templates.js';
import { fillTemplatePdf, resolveMappings } from '../domain/forms/fill.js';
import { buildRoster, loadProviderData } from '../domain/forms/provider-data.js';
import { buildRosterCsv } from '../domain/forms/roster.js';
import { ROSTER_COLUMNS } from '../domain/forms/types.js';

/**
 * The four form tools.
 *
 * A factory for symmetry with the other two groups, though unlike them it closes over nothing:
 * each handler is given the live bag as `d`, and the writes that used to call core-tools' free
 * functions — `writeOutFile`, `stageRelease` — reach them through `d.kernel`, because a pack has
 * no file-store handle of its own and the kernel is what keeps the out tree client-scoped.
 */
export function formTools(): AnyToolDef[] {
  const formsListTemplates = definePackTool({
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
    handler: async (_args, d) => {
      const manifest = await loadManifest(d.formsDir);
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

  const formsFill = definePackTool({
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
    handler: async ({ template_id, provider_id }, d) => {
      const template = await getTemplate(template_id, d.formsDir);
      const data = await loadProviderData(d, provider_id);
      const resolved = resolveMappings(template.mappings, data, d.kernel.isRestrictedName);

      const blockers = resolved.filter((r) => r.required && r.blocked !== null);
      if (blockers.length > 0) {
        const pending = blockers.filter((r) => r.blocked === 'pending').map((r) => r.label);
        const missing = blockers.filter((r) => r.blocked === 'missing').map((r) => r.label);
        const parts: string[] = [];
        if (pending.length > 0) parts.push(`pending human confirmation: ${pending.join(', ')}`);
        if (missing.length > 0) parts.push(`missing from the record: ${missing.join(', ')}`);
        throw new ToolError(`cannot fill ${template_id}: ${parts.join('; ')}`);
      }

      const templateBytes = await readFile(path.join(d.formsDir, template.file));
      const filled = resolved.filter((r) => r.value !== null);
      const bytes = await fillTemplatePdf(
        templateBytes,
        filled.map((r) => ({ pdf_field: r.pdf_field, value: r.value as string })),
      );
      const written = await d.kernel.writeOutFile(d, { dir: 'forms', name: template_id, ext: 'pdf', bytes });

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

  const formsRoster = definePackTool({
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
    handler: async ({ payer_id, provider_ids }, d) => {
      // Preserve the caller's order and drop repeats, so a roster built from a
      // search result does not list a provider twice.
      const rows = await buildRoster(d, payer_id, [...new Set(provider_ids)]);
      const bytes = new TextEncoder().encode(buildRosterCsv(rows));
      const written = await d.kernel.writeOutFile(d, { dir: 'roster', name: payer_id, ext: 'csv', bytes });
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

  const formsRelease = definePackTool({
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
    handler: async (args, d) => {
      try {
        return await d.kernel.stageRelease(d, args);
      } catch (err) {
        // The kernel's message names no pack tool, because the kernel knows of none. This pack
        // does, and the sentence an agent reads has told it which two tools produce a file id
        // since before the kernel was generic; a skill and a test both depend on it.
        if (err instanceof ToolError && err.message === `no generated file with id "${args.file_id}"`) {
          throw new ToolError(`no generated file with id "${args.file_id}"; run forms_fill or forms_roster first`);
        }
        throw err;
      }
    },
  });

  return [formsListTemplates, formsFill, formsRoster, formsRelease];
}
