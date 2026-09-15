import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { fields, credentials, decrypt, type Db } from '@harness/db';
import { registerTools, type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { providerTools } from './providers.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db);
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

const factory = () => {
  const server = new McpServer({ name: 'providers-test', version: '0.0.0' });
  registerTools(server, providerTools, deps);
  return server;
};

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
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const out = (res.structuredContent as { result: { provider_id: string; fields_pending: number; fields_extracted: number; credentials: number } }).result;
    expect(out.fields_pending).toBe(1);
    expect(out.fields_extracted).toBe(2);
    expect(out.credentials).toBe(2);

    const rows = await db.select().from(fields).where(eq(fields.providerId, out.provider_id));
    const ssn = rows.find((r) => r.name === 'ssn')!;
    expect(ssn.value).toBeNull();
    expect(decrypt(ssn.valueEncrypted!, deps.encryptionKey)).toBe('123-45-6789');
    expect(ssn.status).toBe('extracted');
    expect(rows.find((r) => r.name === 'malpractice_carrier')!.status).toBe('pending');

    const creds = await db.select().from(credentials).where(eq(credentials.providerId, out.provider_id));
    expect(creds.every((cr) => cr.numberEncrypted !== null)).toBe(true);
    await c();
  });

  it('upsert is idempotent by (client, npi) and updates existing fields', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const a = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const b = await client.callTool({ name: 'providers_upsert', arguments: { ...upsertArgs, fields: [{ name: 'first_name', value: 'Augusta', confidence: 0.99 }], credentials: [] } });
    const idA = (a.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const idB = (b.structuredContent as { result: { provider_id: string } }).result.provider_id;
    expect(idA).toBe(idB);
    const rows = await db.select().from(fields).where(eq(fields.providerId, idA));
    expect(rows.find((r) => r.name === 'first_name')!.value).toBe('Augusta');
    expect(rows).toHaveLength(3);
    const creds = await db.select().from(credentials).where(eq(credentials.providerId, idA));
    expect(creds).toHaveLength(2);
    await c();
  });

  it('get masks restricted values and returns credentials with masked numbers', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const res = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    const out = (res.structuredContent as { result: { provider: { name: string }; fields: { name: string; value: string | null }[]; credentials: { kind: string; number: string }[] } }).result;
    expect(out.provider.name).toBe('Dr. Ada Lovelace');
    expect(out.fields.find((f) => f.name === 'ssn')!.value).toBe('[restricted]');
    expect(out.fields.find((f) => f.name === 'first_name')!.value).toBe('Ada');
    expect(out.credentials.find((cr) => cr.kind === 'dea')!.number).toBe('[restricted]');
    await c();
  });

  it('search finds by name fragment and by npi', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const byName = await client.callTool({ name: 'providers_search', arguments: { query: 'lovelace' } });
    const byNpi = await client.callTool({ name: 'providers_search', arguments: { query: '1234567890' } });
    expect((byName.structuredContent as { result: { providers: unknown[] } }).result.providers).toHaveLength(1);
    expect((byNpi.structuredContent as { result: { providers: unknown[] } }).result.providers).toHaveLength(1);
    await c();
  });

  it('list_pending and confirm_field', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const pending = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect((pending.structuredContent as { result: { fields: { name: string }[] } }).result.fields.map((f) => f.name)).toEqual(['malpractice_carrier']);

    await client.callTool({ name: 'providers_confirm_field', arguments: { provider_id: id, field: 'malpractice_carrier', value: 'MedPro Group', confirmed_by: 'U123' } });
    const row = (await db.select().from(fields).where(eq(fields.providerId, id))).find((r) => r.name === 'malpractice_carrier')!;
    expect(row).toMatchObject({ status: 'verified', value: 'MedPro Group', confirmedBy: 'U123' });
    expect(row.confirmedAt).not.toBeNull();

    const after = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect((after.structuredContent as { result: { fields: unknown[] } }).result.fields).toHaveLength(0);
    await c();
  });

  it('get returns isError for unknown provider', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'providers_get', arguments: { provider_id: '00000000-0000-0000-0000-000000000000' } });
    expect(res.isError).toBe(true);
    await c();
  });

  it('rejects cross-tenant access to a provider by id', async () => {
    const otherDeps = makeTestDeps(db, { client: 'other-clinic' });
    const otherFactory = () => {
      const server = new McpServer({ name: 'providers-test-other', version: '0.0.0' });
      registerTools(server, providerTools, otherDeps);
      return server;
    };
    const { client: otherClient, close: closeOther } = await makeTestClient(otherFactory);
    const up = await otherClient.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    await closeOther();

    const { client, close: c } = await makeTestClient(factory);
    const getRes = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    expect(getRes.isError).toBe(true);
    const pendingRes = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect(pendingRes.isError).toBe(true);
    const confirmRes = await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'malpractice_carrier', value: 'Nope' },
    });
    expect(confirmRes.isError).toBe(true);

    const rows = await db.select().from(fields).where(eq(fields.providerId, id));
    expect(rows.find((r) => r.name === 'malpractice_carrier')!.value).toBe('MedPro');
    await c();
  });

  it('preserves a verified field across re-extraction', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    await client.callTool({
      name: 'providers_confirm_field',
      arguments: { provider_id: id, field: 'malpractice_carrier', value: 'MedPro Group', confirmed_by: 'U123' },
    });

    const reextract = await client.callTool({
      name: 'providers_upsert',
      arguments: { ...upsertArgs, fields: [{ name: 'malpractice_carrier', value: 'Other Carrier', confidence: 0.99 }], credentials: [] },
    });
    const out = (reextract.structuredContent as { result: { fields_pending: number; fields_extracted: number } }).result;
    expect(out.fields_pending).toBe(0);
    expect(out.fields_extracted).toBe(0);

    const row = (await db.select().from(fields).where(eq(fields.providerId, id))).find((r) => r.name === 'malpractice_carrier')!;
    expect(row.value).toBe('MedPro Group');
    expect(row.status).toBe('verified');
    expect(row.confirmedBy).toBe('U123');
    await c();
  });
});
