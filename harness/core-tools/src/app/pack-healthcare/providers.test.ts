import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { fields, attachments, decrypt } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { connectTools, makeTestDeps, resultOf, useTestDb } from '../../testing.js';

const db = useTestDb();
const deps = makeTestDeps(db);

const connectProviders = () => connectTools('providers-test', healthcarePack.tools!(deps), deps);

/** `providers_upsert`'s result, which most of these tests read the id out of. */
interface UpsertResult {
  provider_id: string;
  fields_pending: number;
  fields_extracted: number;
  credentials: number;
}

const upsertArgs = {
  name: 'Dr. Ada Lovelace',
  npi: '1234567890',
  fields: [
    { name: 'first_name', value: 'Ada', confidence: 0.99 },
    { name: 'ssn', value: '123-45-6789', confidence: 0.97, restricted: true },
    { name: 'malpractice_carrier', value: 'MedPro', confidence: 0.6 },
  ],
  credentials: [
    { kind: 'license', issuer: 'CA Medical Board', number: 'A12345', state: 'CA', expires_at: '2027-03-31' },
    { kind: 'dea', number: 'BL1234567', expires_at: '2026-11-30' },
  ],
};

describe('providers tools', () => {
  it('upsert creates provider, encrypts restricted fields, sets statuses by threshold', async () => {
    const client = await connectProviders();
    const res = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const out = resultOf<UpsertResult>(res);
    expect(out.fields_pending).toBe(1);
    expect(out.fields_extracted).toBe(2);
    expect(out.credentials).toBe(2);

    const rows = await db.select().from(fields).where(eq(fields.recordId, out.provider_id));
    const ssn = rows.find((r) => r.name === 'ssn')!;
    expect(ssn.value).toBeNull();
    expect(decrypt(ssn.valueEncrypted!, deps.encryptionKey)).toBe('123-45-6789');
    expect(ssn.status).toBe('extracted');
    expect(rows.find((r) => r.name === 'malpractice_carrier')!.status).toBe('pending');

    const creds = await db.select().from(attachments).where(eq(attachments.recordId, out.provider_id));
    expect(creds.every((cr) => cr.numberEncrypted !== null)).toBe(true);
  });

  it('upsert is idempotent by (client, npi) and updates existing fields', async () => {
    const client = await connectProviders();
    const a = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const b = await client.callTool({
      name: 'providers_upsert',
      arguments: {
        ...upsertArgs,
        fields: [{ name: 'first_name', value: 'Augusta', confidence: 0.99 }],
        credentials: [],
      },
    });
    const idA = resultOf<UpsertResult>(a).provider_id;
    const idB = resultOf<UpsertResult>(b).provider_id;
    expect(idA).toBe(idB);
    const rows = await db.select().from(fields).where(eq(fields.recordId, idA));
    expect(rows.find((r) => r.name === 'first_name')!.value).toBe('Augusta');
    expect(rows).toHaveLength(3);
    const creds = await db.select().from(attachments).where(eq(attachments.recordId, idA));
    expect(creds).toHaveLength(2);
  });

  it('get masks restricted values and returns credentials with masked numbers', async () => {
    const client = await connectProviders();
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = resultOf<UpsertResult>(up).provider_id;
    const res = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    const out = resultOf<{
      provider: { name: string };
      fields: { name: string; value: string | null }[];
      credentials: { kind: string; number: string }[];
    }>(res);
    expect(out.provider.name).toBe('Dr. Ada Lovelace');
    expect(out.fields.find((f) => f.name === 'ssn')!.value).toBe('[restricted]');
    expect(out.fields.find((f) => f.name === 'first_name')!.value).toBe('Ada');
    expect(out.credentials.find((cr) => cr.kind === 'dea')!.number).toBe('[restricted]');
  });

  it('encrypts and masks an ordinal-suffixed restricted name the caller did not flag', async () => {
    // The name a second redaction hit is stored under. A caller replaying an
    // earlier extraction passes it with no `restricted` flag at all; the name
    // alone has to be enough to keep the value out of the plaintext column.
    const client = await connectProviders();
    const up = await client.callTool({
      name: 'providers_upsert',
      arguments: {
        name: 'Dr. Ada Lovelace',
        fields: [{ name: 'ssn_2', value: '321-65-4321', confidence: 1 }],
        credentials: [],
      },
    });
    const id = resultOf<UpsertResult>(up).provider_id;

    const rows = await db.select().from(fields).where(eq(fields.recordId, id));
    const row = rows.find((r) => r.name === 'ssn_2')!;
    expect(row.restricted).toBe(true);
    expect(row.value).toBeNull();
    expect(decrypt(row.valueEncrypted!, deps.encryptionKey)).toBe('321-65-4321');

    const got = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    const out = resultOf<{ fields: { name: string; value: string | null }[] }>(got);
    expect(out.fields.find((f) => f.name === 'ssn_2')!.value).toBe('[restricted]');
  });

  it('search finds by name fragment and by npi', async () => {
    const client = await connectProviders();
    await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const byName = await client.callTool({ name: 'providers_search', arguments: { query: 'lovelace' } });
    const byNpi = await client.callTool({ name: 'providers_search', arguments: { query: '1234567890' } });
    expect(resultOf<{ providers: unknown[] }>(byName).providers).toHaveLength(1);
    expect(resultOf<{ providers: unknown[] }>(byNpi).providers).toHaveLength(1);
  });

  it('list_pending and confirm_field', async () => {
    const client = await connectProviders();
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = resultOf<UpsertResult>(up).provider_id;
    const pending = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    const pendingFields = resultOf<{ fields: { name: string }[] }>(pending).fields;
    expect(pendingFields.map((f) => f.name)).toEqual(['malpractice_carrier']);

    await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'malpractice_carrier', value: 'MedPro Group', confirmed_by: 'U123' },
    });
    const row = (await db.select().from(fields).where(eq(fields.recordId, id))).find(
      (r) => r.name === 'malpractice_carrier',
    )!;
    expect(row).toMatchObject({ status: 'verified', value: 'MedPro Group', confirmedBy: 'U123' });
    expect(row.confirmedAt).not.toBeNull();

    const after = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect(resultOf<{ fields: unknown[] }>(after).fields).toHaveLength(0);
  });

  it('get returns isError for unknown provider', async () => {
    const client = await connectProviders();
    const res = await client.callTool({
      name: 'providers_get',
      arguments: { provider_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.isError).toBe(true);
  });

  it('rejects cross-tenant access to a provider by id', async () => {
    const otherDeps = makeTestDeps(db, { client: 'other-clinic' });
    const otherClient = await connectTools('providers-test-other', healthcarePack.tools!(otherDeps), otherDeps);
    const up = await otherClient.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = resultOf<UpsertResult>(up).provider_id;

    const client = await connectProviders();
    const getRes = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    expect(getRes.isError).toBe(true);
    const pendingRes = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect(pendingRes.isError).toBe(true);
    const confirmRes = await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'malpractice_carrier', value: 'Nope' },
    });
    expect(confirmRes.isError).toBe(true);

    const rows = await db.select().from(fields).where(eq(fields.recordId, id));
    expect(rows.find((r) => r.name === 'malpractice_carrier')!.value).toBe('MedPro');
  });

  it('preserves a verified field across re-extraction', async () => {
    const client = await connectProviders();
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = resultOf<UpsertResult>(up).provider_id;
    await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'malpractice_carrier', value: 'MedPro Group', confirmed_by: 'U123' },
    });

    const reextract = await client.callTool({
      name: 'providers_upsert',
      arguments: {
        ...upsertArgs,
        fields: [{ name: 'malpractice_carrier', value: 'Other Carrier', confidence: 0.99 }],
        credentials: [],
      },
    });
    const out = resultOf<UpsertResult>(reextract);
    expect(out.fields_pending).toBe(0);
    expect(out.fields_extracted).toBe(0);

    const row = (await db.select().from(fields).where(eq(fields.recordId, id))).find(
      (r) => r.name === 'malpractice_carrier',
    )!;
    expect(row.value).toBe('MedPro Group');
    expect(row.status).toBe('verified');
    expect(row.confirmedBy).toBe('U123');
  });

  it('treats a name-recognised restricted field as restricted even when the caller says otherwise', async () => {
    const client = await connectProviders();
    const res = await client.callTool({
      name: 'providers_upsert',
      arguments: {
        name: 'Dr. Alan Turing',
        npi: '9998887776',
        fields: [{ name: 'ssn', value: '999-88-7777', confidence: 0.99, restricted: false }],
      },
    });
    const id = resultOf<UpsertResult>(res).provider_id;
    const row = (await db.select().from(fields).where(eq(fields.recordId, id))).find((r) => r.name === 'ssn')!;
    expect(row.value).toBeNull();
    expect(row.valueEncrypted).not.toBeNull();
    expect(row.restricted).toBe(true);
    expect(decrypt(row.valueEncrypted!, deps.encryptionKey)).toBe('999-88-7777');
  });

  it('confirm_field keeps a name-recognised restricted value out of plaintext', async () => {
    const client = await connectProviders();
    const up = await client.callTool({
      name: 'providers_upsert',
      arguments: { name: 'Dr. Alan Turing', npi: '9998887776' },
    });
    const id = resultOf<UpsertResult>(up).provider_id;
    await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'DEA-Number', value: 'BX1234563', confirmed_by: 'U9' },
    });
    const row = (await db.select().from(fields).where(eq(fields.recordId, id))).find((r) => r.name === 'DEA-Number')!;
    expect(row.value).toBeNull();
    expect(row.restricted).toBe(true);
    expect(decrypt(row.valueEncrypted!, deps.encryptionKey)).toBe('BX1234563');
  });
});

describe('approval payload redaction', () => {
  const redactOf = (name: string) => {
    const tool = healthcarePack.tools!(deps).find((t) => t.name === name)!;
    if (!tool.redact) throw new Error(`${name} defines no redact`);
    return tool.redact;
  };

  it('providers_upsert masks restricted field values and every credential number', () => {
    const redacted = redactOf('providers_upsert')({
      name: 'Dr. Ada Lovelace',
      npi: '1234567890',
      fields: [
        { name: 'first_name', value: 'Ada' },
        { name: 'ssn', value: '123-45-6789', restricted: false },
        { name: 'nickname', value: 'secret', restricted: true },
      ],
      credentials: [
        { kind: 'dea', number: 'BL1234567' },
        { kind: 'license', state: 'CA' },
      ],
    }) as { fields: { name: string; value: string }[]; credentials: { kind: string; number?: string }[] };

    expect(redacted.fields).toEqual([
      { name: 'first_name', value: 'Ada' },
      { name: 'ssn', value: '[restricted]', restricted: false },
      { name: 'nickname', value: '[restricted]', restricted: true },
    ]);
    expect(redacted.credentials).toEqual([
      { kind: 'dea', number: '[restricted]' },
      { kind: 'license', state: 'CA' },
    ]);
  });

  it('providers_confirm_field masks the value only for a restricted field name', () => {
    const redact = redactOf('providers_confirm_field');
    expect(redact({ provider_id: 'p', field: 'tax_id', value: '12-3456789' })).toMatchObject({
      field: 'tax_id',
      value: '[restricted]',
    });
    expect(redact({ provider_id: 'p', field: 'first_name', value: 'Ada' })).toMatchObject({
      field: 'first_name',
      value: 'Ada',
    });
  });
});
