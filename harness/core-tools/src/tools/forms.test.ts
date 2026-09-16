import { mkdtemp, rm, writeFile, access, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, credentials, fields, providers, approvals, toolEffects } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { useTestDb, makeTestDeps, connectTools, resultOf, approvalIdOf } from '../testing.js';
import { ROSTER_COLUMNS } from '../domain/forms/types.js';
import type { ToolDeps } from '../domain/tooling/types.js';
import { approvalTools } from './approvals.js';
import { formTools } from './forms.js';

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
  deps = makeTestDeps(db, { storageDir, formsDir: healthcarePack.formsDir });
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

/** A provider whose non-restricted fields and credentials are complete enough to fill. */
async function seedCompleteProvider(): Promise<string> {
  const [p] = await db
    .insert(providers)
    .values({ client: 'test', name: 'Dr. Ada Reyes', npi: '1234567893' })
    .returning();
  await db.insert(fields).values([
    { providerId: p.id, name: 'primary_specialty', value: 'Family Medicine', status: 'verified', confidence: 1 },
    {
      providerId: p.id,
      name: 'practice_address',
      value: '12 Elm St, Austin TX',
      status: 'extracted',
      confidence: 0.95,
    },
    { providerId: p.id, name: 'practice_name', value: 'Elm Street Family Care', status: 'extracted', confidence: 0.92 },
  ]);
  await db.insert(credentials).values([
    {
      providerId: p.id,
      kind: 'license',
      issuer: 'Texas Medical Board',
      state: 'TX',
      expiresAt: '2027-03-31',
      numberEncrypted: Buffer.from('enc'),
    },
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
      path.join(healthcarePack.formsDir, 'state-license-renewal-cover.pdf'),
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
    const res = await client.callTool({
      name: 'forms_fill',
      arguments: { template_id: 'leaky', provider_id: providerId },
    });
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
      path.join(healthcarePack.formsDir, 'state-license-renewal-cover.pdf'),
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

describe('forms_roster', () => {
  it('writes a CSV with the documented columns and one row per provider', async () => {
    const first = await seedCompleteProvider();
    const [second] = await db
      .insert(providers)
      .values({ client: 'test', name: 'Dr. Bo Lin', npi: '1987654320' })
      .returning();
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ file_id: string; rows: number; columns: string[] }>(
      await client.callTool({
        name: 'forms_roster',
        arguments: { payer_id: 'aetna', provider_ids: [first, second.id] },
      }),
    );
    expect(out.rows).toBe(2);
    expect(out.columns).toEqual([...ROSTER_COLUMNS]);
    expect(out.file_id).toMatch(/^roster\/aetna-[0-9a-f]{12}\.csv$/);
    const csv = await readFile(path.join(storageDir, 'out', out.file_id), 'utf8');
    expect(csv.split('\n')[0]).toBe(ROSTER_COLUMNS.join(','));
    expect(csv).toContain('Dr. Ada Reyes');
    expect(csv).toContain('Dr. Bo Lin');
  });

  it('reports a licence as on file without exporting the number', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ file_id: string }>(
      await client.callTool({ name: 'forms_roster', arguments: { payer_id: 'aetna', provider_ids: [providerId] } }),
    );
    const csv = await readFile(path.join(storageDir, 'out', out.file_id), 'utf8');
    expect(csv).toContain(',yes,no,');
    expect(csv).not.toContain('enc');
  });

  it('reports a licence with no stored number as not on file', async () => {
    // A licence read off a document that showed an issuer, a state and an
    // expiry but no legible number: the row exists, number_encrypted is null.
    const [p] = await db
      .insert(providers)
      .values({ client: 'test', name: 'Dr. No Number', npi: '1234567893' })
      .returning();
    await db.insert(credentials).values([
      { providerId: p.id, kind: 'license', issuer: 'Texas Medical Board', state: 'TX', expiresAt: '2027-03-31' },
      { providerId: p.id, kind: 'dea', issuer: 'DEA', expiresAt: '2028-02-28' },
    ]);
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ file_id: string }>(
      await client.callTool({ name: 'forms_roster', arguments: { payer_id: 'aetna', provider_ids: [p.id] } }),
    );
    const csv = await readFile(path.join(storageDir, 'out', out.file_id), 'utf8');
    const [, row] = csv.trim().split('\n');
    const cells = row.split(',');
    // license_number_on_file and dea_on_file, in ROSTER_COLUMNS order.
    expect(cells[ROSTER_COLUMNS.indexOf('license_number_on_file')]).toBe('no');
    expect(cells[ROSTER_COLUMNS.indexOf('dea_on_file')]).toBe('no');
    // The rest of the licence row is still exported: the row does exist.
    expect(cells[ROSTER_COLUMNS.indexOf('license_state')]).toBe('TX');
    expect(cells[ROSTER_COLUMNS.indexOf('license_expires_at')]).toBe('2027-03-31');
  });

  it('reports a DEA registration with a stored number as on file', async () => {
    const [p] = await db
      .insert(providers)
      .values({ client: 'test', name: 'Dr. Has Number', npi: '1234567893' })
      .returning();
    await db.insert(credentials).values({
      providerId: p.id,
      kind: 'dea',
      issuer: 'DEA',
      expiresAt: '2028-02-28',
      numberEncrypted: Buffer.from('enc'),
    });
    const client = await connectTools('forms-test', formTools, deps);
    const out = resultOf<{ file_id: string }>(
      await client.callTool({ name: 'forms_roster', arguments: { payer_id: 'aetna', provider_ids: [p.id] } }),
    );
    const csv = await readFile(path.join(storageDir, 'out', out.file_id), 'utf8');
    const cells = csv.trim().split('\n')[1].split(',');
    expect(cells[ROSTER_COLUMNS.indexOf('dea_on_file')]).toBe('yes');
    expect(csv).not.toContain('enc');
  });

  it('refuses a provider that belongs to another client and writes nothing', async () => {
    const mine = await seedCompleteProvider();
    const [theirs] = await db.insert(providers).values({ client: 'other-clinic', name: 'Dr. Elsewhere' }).returning();
    const client = await connectTools('forms-test', formTools, deps);
    const res = await client.callTool({
      name: 'forms_roster',
      arguments: { payer_id: 'aetna', provider_ids: [mine, theirs.id] },
    });
    expect(res.isError).toBe(true);
    await expect(access(path.join(storageDir, 'out', 'roster'))).rejects.toThrow();
  });
});

describe('forms_release', () => {
  it('parks an approval instead of sending, and stages nothing yet', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', [...formTools, ...approvalTools], deps);
    const filled = resultOf<{ file_id: string }>(
      await client.callTool({
        name: 'forms_fill',
        arguments: { template_id: 'state-license-renewal-cover', provider_id: providerId },
      }),
    );
    const res = await client.callTool({ name: 'forms_release', arguments: { file_id: filled.file_id } });
    const approvalId = approvalIdOf(res);
    expect(approvalId).toBeTruthy();
    expect(await db.select().from(toolEffects)).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row.action).toBe('forms_release');
    expect(row.status).toBe('pending');
  });

  it('stages exactly one slack_file effect when the approval is executed', async () => {
    const providerId = await seedCompleteProvider();
    const client = await connectTools('forms-test', [...formTools, ...approvalTools], deps);
    const filled = resultOf<{ file_id: string }>(
      await client.callTool({
        name: 'forms_fill',
        arguments: { template_id: 'state-license-renewal-cover', provider_id: providerId },
      }),
    );
    const approvalId = approvalIdOf(
      await client.callTool({ name: 'forms_release', arguments: { file_id: filled.file_id } }),
    );
    await db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'U1', decidedAt: deps.now() })
      .where(eq(approvals.id, approvalId));

    await client.callTool({ name: 'approvals_execute', arguments: { approval_id: approvalId } });
    const effects = await db.select().from(toolEffects);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ sink: 'slack_file', tool: 'forms_release', status: 'staged', client: 'test' });
    expect(effects[0].idempotencyKey).toBe(`test:forms_release:${filled.file_id}`);
    expect(effects[0].summary).not.toContain(storageDir);
  });

  it('refuses a file id that escapes the output directory', async () => {
    const strict = makeTestDeps(db, {
      storageDir,
      formsDir: healthcarePack.formsDir,
      policy: { ...deps.policy, external: 'auto' },
    });
    const client = await connectTools('forms-test', [...formTools, ...approvalTools], strict);
    const res = await client.callTool({ name: 'forms_release', arguments: { file_id: '../../etc/passwd' } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it('refuses a file id that does not exist', async () => {
    const strict = makeTestDeps(db, {
      storageDir,
      formsDir: healthcarePack.formsDir,
      policy: { ...deps.policy, external: 'auto' },
    });
    const client = await connectTools('forms-test', [...formTools, ...approvalTools], strict);
    const res = await client.callTool({
      name: 'forms_release',
      arguments: { file_id: 'forms/never-written-000000000000.pdf' },
    });
    expect(res.isError).toBe(true);
  });
});
