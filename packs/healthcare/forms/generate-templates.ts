/**
 * Regenerate the demo AcroForm templates.
 *
 * We have no real payer templates to ship, so the pack carries two plausible
 * ones built here. Output is deterministic — fixed metadata dates, no random
 * ids — so re-running this leaves `git status` clean unless a field actually
 * changed, and a reviewer can tell a content change from a rebuild.
 *
 * Run: pnpm forms:generate
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

interface Row {
  label: string;
  field: string;
}

interface Template {
  file: string;
  title: string;
  rows: Row[];
}

const TEMPLATES: Template[] = [
  {
    file: 'payer-credentialing-application.pdf',
    title: 'Payer Credentialing Application (demo)',
    rows: [
      { label: 'Provider full name', field: 'provider_full_name' },
      { label: 'NPI', field: 'provider_npi' },
      { label: 'Primary specialty', field: 'primary_specialty' },
      { label: 'Practice name', field: 'practice_name' },
      { label: 'Practice address', field: 'practice_address' },
      { label: 'License state', field: 'license_state' },
      { label: 'License expires', field: 'license_expires_at' },
      { label: 'Malpractice carrier', field: 'malpractice_carrier' },
      { label: 'Malpractice expires', field: 'malpractice_expires_at' },
      { label: 'Board cert expires', field: 'board_cert_expires_at' },
    ],
  },
  {
    file: 'state-license-renewal-cover.pdf',
    title: 'State License Renewal Cover Sheet (demo)',
    rows: [
      { label: 'Provider full name', field: 'provider_full_name' },
      { label: 'NPI', field: 'provider_npi' },
      { label: 'License state', field: 'license_state' },
      { label: 'Issuing board', field: 'license_issuer' },
      { label: 'License expires', field: 'license_expires_at' },
      { label: 'Practice address', field: 'practice_address' },
    ],
  },
];

function drawHeading(page: PDFPage, font: PDFFont, title: string): void {
  page.drawText(title, { x: 54, y: 740, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText('Demo template. Restricted identifiers are never printed on this form.', {
    x: 54,
    y: 720,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
}

async function build(template: Template): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Pinned so two runs produce byte-identical files.
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setTitle(template.title);
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  drawHeading(page, font, template.title);

  const form = doc.getForm();
  let y = 670;
  for (const row of template.rows) {
    page.drawText(`${row.label}:`, { x: 54, y: y + 5, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    const field = form.createTextField(row.field);
    field.setText('');
    field.addToPage(page, { x: 230, y, width: 320, height: 18, font });
    y -= 34;
  }
  return doc.save();
}

for (const template of TEMPLATES) {
  const bytes = await build(template);
  await writeFile(path.join(HERE, template.file), bytes);
  console.log(`wrote ${template.file} (${bytes.byteLength} bytes)`);
}
