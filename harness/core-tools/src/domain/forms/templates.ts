import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '@harness/shared';
import { TemplateManifest, type FormTemplate, type TemplateMapping } from './types.js';

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
