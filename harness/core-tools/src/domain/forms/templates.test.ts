import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { loadManifest, getTemplate, mappingLabel } from './templates.js';

const dir = healthcarePack.formsDir;

describe('form template manifest', () => {
  it('parses and names two demo templates', async () => {
    const manifest = await loadManifest(dir);
    expect(manifest.templates.map((t) => t.id).sort()).toEqual([
      'payer-credentialing-application',
      'state-license-renewal-cover',
    ]);
  });

  it('maps only form fields that exist in the PDF', async () => {
    const manifest = await loadManifest(dir);
    for (const template of manifest.templates) {
      const bytes = await readFile(path.join(dir, template.file));
      const pdf = await PDFDocument.load(bytes);
      const names = new Set(
        pdf
          .getForm()
          .getFields()
          .map((f) => f.getName()),
      );
      for (const mapping of template.mappings) {
        expect(names, `${template.id} -> ${mapping.pdf_field}`).toContain(mapping.pdf_field);
      }
    }
  });

  it('never maps a restricted identifier', async () => {
    const manifest = await loadManifest(dir);
    for (const template of manifest.templates) {
      for (const mapping of template.mappings) {
        if (mapping.source === 'field') expect(isRestrictedName(mapping.name)).toBe(false);
        if (mapping.source === 'credential') expect(mapping.property).not.toBe('number');
      }
    }
  });

  it('labels a mapping by name, never by value', async () => {
    const template = await getTemplate('payer-credentialing-application', dir);
    const labels = template.mappings.map(mappingLabel);
    expect(labels).toContain('provider.name');
    expect(labels).toContain('field:primary_specialty');
    expect(labels).toContain('credential:license.expires_at');
  });

  it('refuses an unknown template id', async () => {
    await expect(getTemplate('no-such-template', dir)).rejects.toThrow(/unknown form template/);
  });
});
