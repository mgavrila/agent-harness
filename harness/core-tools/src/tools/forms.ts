import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { eq, sql } from 'drizzle-orm';
import { credentials, fields } from '@harness/db';
import { ToolError } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import { writeOutFile, resolveOutFile } from '../domain/storage/file-store.js';
import { stageEffect } from '../effects.js';
import { getTemplate, loadManifest, mappingLabel } from '../forms/templates.js';
import { fillTemplatePdf, latestCredential, resolveMappings, type ProviderData } from '../forms/fill.js';
import { buildRosterCsv, ROSTER_COLUMNS, type RosterRow } from '../forms/roster.js';
import { requireProvider } from './providers.js';

/**
 * Read everything a template may need about one provider, scoped to the client.
 *
 * Both queries are projections rather than `select()`: the encrypted columns
 * are never pulled into this process, and `number_encrypted IS NOT NULL` is
 * evaluated by Postgres. That is what lets the roster say whether a credential
 * number is on file without the bytes ever being in memory.
 */
export async function loadProviderData(deps: ToolDeps, providerId: string): Promise<ProviderData> {
  const provider = await requireProvider(deps, providerId);
  const fieldRows = await deps.db
    .select({ name: fields.name, value: fields.value, restricted: fields.restricted, status: fields.status })
    .from(fields)
    .where(eq(fields.providerId, providerId));
  const credentialRows = await deps.db
    .select({
      kind: credentials.kind,
      issuer: credentials.issuer,
      state: credentials.state,
      issuedAt: credentials.issuedAt,
      expiresAt: credentials.expiresAt,
      hasNumber: sql<boolean>`${credentials.numberEncrypted} is not null`,
    })
    .from(credentials)
    .where(eq(credentials.providerId, providerId));
  return {
    provider: { name: provider.name, npi: provider.npi, status: provider.status },
    fields: fieldRows,
    credentials: credentialRows,
  };
}

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

/** Slack rejects very large uploads and a 25 MB roster is a bug, not a roster. */
const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

const fieldValue = (data: ProviderData, name: string): string | null => {
  const row = data.fields.find((f) => f.name === name);
  if (!row || row.restricted) return null;
  return row.status === 'extracted' || row.status === 'verified' ? row.value : null;
};

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
    const unique = [...new Set(provider_ids)];
    const rows: RosterRow[] = [];
    for (const providerId of unique) {
      // requireProvider inside loadProviderData scopes this to deps.client, so
      // one unknown id aborts the whole roster rather than silently skipping.
      const data = await loadProviderData(deps, providerId);
      const license = latestCredential(data, 'license');
      const malpractice = latestCredential(data, 'malpractice');
      const boardCert = latestCredential(data, 'board_cert');
      rows.push({
        payer_id,
        provider_name: data.provider.name,
        npi: data.provider.npi,
        primary_specialty: fieldValue(data, 'primary_specialty'),
        practice_address: fieldValue(data, 'practice_address'),
        license_state: license?.state ?? null,
        license_issuer: license?.issuer ?? null,
        license_expires_at: license?.expiresAt ?? null,
        // "On file" means a number is stored, not that a credential row
        // exists: `number_encrypted` is nullable, so a licence recorded from a
        // document with no legible number must report no.
        license_number_on_file: license?.hasNumber ?? false,
        dea_on_file: latestCredential(data, 'dea')?.hasNumber ?? false,
        malpractice_carrier: malpractice?.issuer ?? null,
        malpractice_expires_at: malpractice?.expiresAt ?? null,
        board_cert_expires_at: boardCert?.expiresAt ?? null,
        provider_status: data.provider.status,
      });
    }
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
  handler: async ({ file_id, channel }, deps) => {
    const absolute = await resolveOutFile(file_id, deps.storageDir);
    let size: number;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      throw new ToolError(`no generated file with id "${file_id}"; run forms_fill or forms_roster first`);
    }
    if (size > MAX_RELEASE_BYTES) {
      throw new ToolError(`file "${file_id}" is ${size} bytes, over the ${MAX_RELEASE_BYTES} byte release limit`);
    }
    const filename = path.basename(absolute);
    // Keyed on the file id, which is content-addressed: releasing the same
    // bytes twice is one delivery, and re-filling after a correction produces
    // a new id and therefore a new delivery.
    const staged = await stageEffect(deps, {
      sink: 'slack_file',
      idempotencyKey: `forms_release:${file_id}${channel ? `:${channel}` : ''}`,
      payload: { file_id, path: absolute, filename, channel: channel ?? null },
      summary: `Release ${filename} to Slack`,
    });
    return { effect_id: staged.effect_id, staged: staged.staged, file_id, filename, bytes: size };
  },
});

export const formTools: AnyToolDef[] = [formsListTemplates, formsFill, formsRoster, formsRelease];
