import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, access, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { auditLog, credentials, fields, providers } from '@harness/db';
import { useTestDb, makeTestDeps, connectTools, resultOf } from '../testing.js';
import { defaultFormsDir } from '../forms/templates.js';
import { formTools } from './forms.js';
import type { ToolDeps } from '../registry.js';

const eqField = (providerId: string, name: string) => and(eq(fields.providerId, providerId), eq(fields.name, name));

/** The text content of a tool result, for asserting on error messages. */
function textOf(res: { content?: unknown }): string {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

const db = useTestDb();
let storageDir: string;
let deps: ToolDeps;

beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-forms-'));
  deps = makeTestDeps(db, { storageDir, formsDir: defaultFormsDir() });
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

/** A provider whose non-restricted fields and credentials are complete enough to fill. */
async function seedCompleteProvider(): Promise<string> {
  const [p] = await db.insert(providers).values({ client: 'test', name: 'Dr. Ada Reyes', npi: '1234567893' }).returning();
  await db.insert(fields).values([
    { providerId: p.id, name: 'primary_specialty', value: 'Family Medicine', status: 'verified', confidence: 1 },
    { providerId: p.id, name: 'practice_address', value: '12 Elm St, Austin TX', status: 'extracted', confidence: 0.95 },
    { providerId: p.id, name: 'practice_name', value: 'Elm Street Family Care', status: 'extracted', confidence: 0.92 },
  ]);
  await db.insert(credentials).values([
    { providerId: p.id, kind: 'license', issuer: 'Texas Medical Board', state: 'TX', expiresAt: '2027-03-31', numberEncrypted: Buffer.from('enc') },
    { providerId: p.id, kind: 'malpractice', issuer: 'MedPro', expiresAt: '2027-01-15' },
    { providerId: p.id, kind: 'board_cert', issuer: 'ABFM', expiresAt: '2029-06-30' },
  ]);
  return p.id;
}

describe('forms_list_templates', () => {
  it('lists the installed templates with their required inputs', async () => {
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ templates: { id: string; title: string; required_inputs: string[] }[] }>(
      await client.callTool({ name: 'forms_list_templates', arguments: {} }),
    );
    const app = out.templates.find((t) => t.id === 'payer-credentialing-application');
    expect(app?.title).toContain('Payer Credentialing Application');
    expect(app?.required_inputs).toContain('credential:license.expires_at');
  });
});

describe('forms_fill', () => {
  it('fills a template and writes a content-addressed PDF under out/', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ file_id: string; bytes: number; filled: string[]; left_blank: string[] }>(
      await client.callTool({
        name: 'forms_fill',
        arguments: { template_id: 'payer-credentialing-application', provider_id: providerId },
      }),
    );
    expect(out.file_id).toMatch(/^forms\/payer-credentialing-application-[0-9a-f]{12}\.pdf$/);
    expect(out.bytes).toBeGreaterThan(1000);
    expect(out.filled).toContain('provider.name');
    await expect(access(path.join(storageDir, 'out', out.file_id))).resolves.toBeUndefined();
    const bytes = await readFile(path.join(storageDir, 'out', out.file_id));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('produces the same file id for the same inputs', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', formTools, deps);
    const args = { template_id: 'state-license-renewal-cover', provider_id: providerId };
    const first = resultOf<{ file_id: string }>(await client.callTool({ name: 'forms_fill', arguments: args }));
    const second = resultOf<{ file_id: string }>(await client.callTool({ name: 'forms_fill', arguments: args }));
    expect(second.file_id).toBe(first.file_id);
  });

  it('refuses when a required field is still pending, and names the field', async () => {
    const providerId = await seedCompleteProvider();
    await db.update(fields).set({ status: 'pending', confidence: 0.4 }).where(eqField(providerId, 'practice_address'));
    const client = await connectTools('forms-test', formTools, deps);
    const res = await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'payer-credentialing-application', provider_id: providerId },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('field:practice_address');
    expect(textOf(res)).toContain('pending');
  });

  it('refuses when a required credential is missing', async () => {
    const [p] = await db.insert(providers).values({ client: 'test', name: 'Dr. Bare', npi: '1999999998' }).returning();
    const client = await connectTools('forms-test', formTools, deps);
    const res = await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'state-license-renewal-cover', provider_id: p.id },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('credential:license.expires_at');
  });

  it('leaves an optional mapping blank instead of refusing', async () => {
    const providerId = await seedCompleteProvider();
    await db.delete(fields).where(eqField(providerId, 'practice_name'));
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ left_blank: string[] }>(
      await client.callTool({
        name: 'forms_fill',
        arguments: { template_id: 'payer-credentialing-application', provider_id: providerId },
      }),
    );
    expect(out.left_blank).toContain('field:practice_name');
  });

  it('refuses a template that maps a restricted identifier', async () => {
    const providerId = await seedCompleteProvider();
    const badDir = await mkdtemp(path.join(tmpdir(), 'harness-badforms-'));
    await copyFile(
      path.join(defaultFormsDir(), 'state-license-renewal-cover.pdf'),
      path.join(badDir, 'state-license-renewal-cover.pdf'),
    );
    await writeFile(
      path.join(badDir, 'templates.json'),
      JSON.stringify({
        version: 1,
        templates: [
          {
            id: 'leaky',
            title: 'Leaky template',
            file: 'state-license-renewal-cover.pdf',
            mappings: [{ pdf_field: 'provider_full_name', source: 'field', name: 'dea_number', required: true }],
          },
        ],
      }),
    );
    const leaky = makeTestDeps(db, { storageDir, formsDir: badDir });
    const client = await connectTools('forms-test', formTools, leaky);
    const res = await client.callTool({ name: 'forms_fill', arguments: { template_id: 'leaky', provider_id: providerId } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('restricted');
    await rm(badDir, { recursive: true, force: true });
  });

  it('refuses a provider that belongs to another client', async () => {
    const [p] = await db.insert(providers).values({ client: 'other-clinic', name: 'Dr. Elsewhere' }).returning();
    const client = await connectTools('forms-test', formTools, deps);
    const res = await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'state-license-renewal-cover', provider_id: p.id },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not found');
  });

  it('audits a successful fill with the provider id, and no field values anywhere in the row', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', formTools, deps);
    await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'payer-credentialing-application', provider_id: providerId },
    });
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'forms_fill'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'auto', recordIds: [providerId] });
    const dump = JSON.stringify(rows[0]);
    expect(dump).not.toContain('Family Medicine');
    expect(dump).not.toContain('Elm Street Family Care');
    expect(dump).not.toContain('12 Elm St');
    expect(dump).not.toContain('Texas Medical Board');
  });

  it('audits a refused fill (pending field) as an error, without the field value', async () => {
    const providerId = await seedCompleteProvider();
    await db.update(fields).set({ status: 'pending', confidence: 0.4 }).where(eqField(providerId, 'practice_address'));
    const client = await connectTools('forms-test', formTools, deps);
    await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'payer-credentialing-application', provider_id: providerId },
    });
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'forms_fill'));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('error');
    expect(rows[0].error).toContain('field:practice_address');
    expect(rows[0].error).not.toContain('12 Elm St, Austin TX');
  });

  it('refuses an optional mapping that names a restricted field, naming only the mapping label', async () => {
    const providerId = await seedCompleteProvider();
    const badDir = await mkdtemp(path.join(tmpdir(), 'harness-badforms-optional-'));
    await copyFile(
      path.join(defaultFormsDir(), 'state-license-renewal-cover.pdf'),
      path.join(badDir, 'state-license-renewal-cover.pdf'),
    );
    await writeFile(
      path.join(badDir, 'templates.json'),
      JSON.stringify({
        version: 1,
        templates: [
          {
            id: 'leaky-optional',
            title: 'Leaky optional template',
            file: 'state-license-renewal-cover.pdf',
            mappings: [
              { pdf_field: 'provider_full_name', source: 'provider', property: 'name', required: true },
              { pdf_field: 'license_state', source: 'field', name: 'dea_number', required: false },
            ],
          },
        ],
      }),
    );
    const leaky = makeTestDeps(db, { storageDir, formsDir: badDir });
    const client = await connectTools('forms-test', formTools, leaky);
    const res = await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'leaky-optional', provider_id: providerId },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('field:dea_number');
    expect(textOf(res)).toContain('restricted');
    await rm(badDir, { recursive: true, force: true });
  });
});
