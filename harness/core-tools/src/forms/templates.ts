import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
import { CREDENTIAL_KINDS } from '../deadlines/compute.js';

/**
 * Credential columns a template may print. `number` is deliberately absent:
 * it is stored encrypted and a filled form is uploaded to Slack, so there is
 * no path by which a credential number may reach a PDF.
 */
const CREDENTIAL_PROPERTIES = ['issuer', 'state', 'issued_at', 'expires_at'] as const;

export const TemplateMapping = z.discriminatedUnion('source', [
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('provider'),
    property: z.enum(['name', 'npi']),
    required: z.boolean(),
  }),
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('field'),
    name: z.string().min(1),
    required: z.boolean(),
  }),
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('credential'),
    kind: z.enum(CREDENTIAL_KINDS),
    property: z.enum(CREDENTIAL_PROPERTIES),
    required: z.boolean(),
  }),
]);
export type TemplateMapping = z.infer<typeof TemplateMapping>;

export const FormTemplate = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/),
  mappings: z.array(TemplateMapping).min(1),
});
export type FormTemplate = z.infer<typeof FormTemplate>;

export const TemplateManifest = z.object({
  version: z.literal(1),
  templates: z.array(FormTemplate).min(1),
});
export type TemplateManifest = z.infer<typeof TemplateManifest>;

/**
 * Where the pack's templates live when nothing overrides it: four levels up
 * from `harness/core-tools/src/forms/` is the repository root.
 */
export function defaultFormsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packs/healthcare/forms');
}

export async function loadManifest(dir: string): Promise<TemplateManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, 'templates.json'), 'utf8');
  } catch {
    throw new ToolError(`no form templates are installed (expected templates.json in ${dir})`);
  }
  const parsed = TemplateManifest.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // Issue paths name keys, never values, so this is safe to surface.
    const first = parsed.error.issues[0];
    throw new ToolError(`templates.json is invalid at ${first.path.join('.')}: ${first.message}`);
  }
  return parsed.data;
}

export async function getTemplate(id: string, dir: string): Promise<FormTemplate> {
  const manifest = await loadManifest(dir);
  const template = manifest.templates.find((t) => t.id === id);
  if (!template) {
    throw new ToolError(`unknown form template "${id}"; call forms_list_templates for the installed ones`);
  }
  return template;
}

/** A mapping's human label. Names only — a label is printed in errors and results. */
export function mappingLabel(m: TemplateMapping): string {
  switch (m.source) {
    case 'provider':
      return `provider.${m.property}`;
    case 'field':
      return `field:${m.name}`;
    case 'credential':
      return `credential:${m.kind}.${m.property}`;
  }
}
