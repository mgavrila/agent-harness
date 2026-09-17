import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pack as healthcarePack } from '../../index.js';
import { fillTemplatePdf } from './fill.js';

describe('fillTemplatePdf', () => {
  it('writes the given values into the named fields, leaving an unmapped field blank', async () => {
    const templateBytes = await readFile(path.join(healthcarePack.formsDir!, 'payer-credentialing-application.pdf'));
    const values = [
      { pdf_field: 'provider_full_name', value: 'Dr. Ada Reyes' },
      { pdf_field: 'provider_npi', value: '1234567893' },
      { pdf_field: 'license_expires_at', value: '2027-03-31' },
    ];

    // flatten: false keeps the AcroForm fields readable, so the test can
    // reload the bytes and check what was actually written rather than
    // trusting the writer.
    const filled = await fillTemplatePdf(templateBytes, values, { flatten: false });

    const doc = await PDFDocument.load(filled);
    const form = doc.getForm();
    expect(form.getTextField('provider_full_name').getText()).toBe('Dr. Ada Reyes');
    expect(form.getTextField('provider_npi').getText()).toBe('1234567893');
    expect(form.getTextField('license_expires_at').getText()).toBe('2027-03-31');

    // practice_name is an optional mapping that was left out of `values`
    // entirely; the template must not have pre-filled it from somewhere else.
    expect(form.getTextField('practice_name').getText() ?? '').toBe('');
  });

  it('flattens by default, leaving no fillable fields behind', async () => {
    const templateBytes = await readFile(path.join(healthcarePack.formsDir!, 'payer-credentialing-application.pdf'));
    const filled = await fillTemplatePdf(templateBytes, [{ pdf_field: 'provider_full_name', value: 'Dr. Ada Reyes' }]);
    const doc = await PDFDocument.load(filled);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });
});
