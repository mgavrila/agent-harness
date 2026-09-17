import { describe, expect, it } from 'vitest';
import { attachments, fields, records } from '@harness/db';
import { and, eq } from 'drizzle-orm';
import { ToolError } from '@harness/shared';
import { makeTestDeps, useTestDb } from '../../testing.js';
import {
  confirmField,
  listPendingFields,
  readRecord,
  requireRecord,
  searchRecords,
  upsertRecord,
} from './repository.js';

const db = useTestDb();

const provider = (over: Record<string, unknown> = {}) => ({
  kind: 'provider',
  name: 'Ada Reyes',
  external_id: '1234567890',
  fields: [{ name: 'specialty', value: 'Family Medicine', confidence: 0.99 }],
  attachments: [{ kind: 'license', issuer: 'TX Medical Board', state: 'TX', expires_at: '2027-03-31' }],
  ...over,
});

describe('upsertRecord', () => {
  it('stamps the pack that declares the kind, so a row says which area of the product owns it', async () => {
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(deps, provider());
    const row = await deps.db.query.records.findFirst({ where: eq(records.id, record_id) });
    expect(row).toMatchObject({ pack: 'healthcare', kind: 'provider', client: 'test', name: 'Ada Reyes' });
  });

  it('refuses a kind no loaded pack declares, rather than writing a row nothing can read back', async () => {
    const deps = makeTestDeps(db);
    await expect(upsertRecord(deps, provider({ kind: 'epic' }))).rejects.toThrow(ToolError);
    await expect(upsertRecord(deps, provider({ kind: 'epic' }))).rejects.toThrow(
      'no loaded pack declares record kind "epic"',
    );
  });

  it('matches an existing record on external_id within the kind, and on name when there is none', async () => {
    const deps = makeTestDeps(db);
    const first = await upsertRecord(deps, provider());
    const again = await upsertRecord(deps, provider({ name: 'Ada M Reyes' }));
    expect(again.record_id).toBe(first.record_id);

    const noId = await upsertRecord(deps, provider({ name: 'Bo Lin', external_id: undefined }));
    const sameName = await upsertRecord(deps, provider({ name: 'Bo Lin', external_id: undefined }));
    expect(sameName.record_id).toBe(noId.record_id);
    expect(noId.record_id).not.toBe(first.record_id);
  });

  it('never crosses a client, even on an identical external id', async () => {
    const a = await upsertRecord(makeTestDeps(db, { client: 'a' }), provider());
    const b = await upsertRecord(makeTestDeps(db, { client: 'b' }), provider());
    expect(a.record_id).not.toBe(b.record_id);
  });

  it('leaves a verified field alone and counts it as neither pending nor extracted', async () => {
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(deps, provider());
    await confirmField(deps, { record_id, field: 'specialty', value: 'Cardiology' });
    const second = await upsertRecord(
      deps,
      provider({ fields: [{ name: 'specialty', value: 'Dermatology', confidence: 1 }] }),
    );
    expect(second.fields_extracted).toBe(0);
    expect(second.fields_pending).toBe(0);
    const read = await readRecord(deps, record_id);
    expect(read.fields.find((f) => f.name === 'specialty')?.value).toBe('Cardiology');
  });

  it('encrypts a restricted field by name whatever the caller says, and masks it on the way out', async () => {
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(deps, provider({ fields: [{ name: 'ssn', value: '123-45-6789' }] }));
    const row = await deps.db.query.fields.findFirst({
      where: and(eq(fields.recordId, record_id), eq(fields.name, 'ssn')),
    });
    expect(row?.value).toBeNull();
    expect(row?.valueEncrypted).not.toBeNull();
    const read = await readRecord(deps, record_id);
    expect(read.fields.find((f) => f.name === 'ssn')?.value).toBe('[restricted]');
  });

  it('holds one attachment of a kind per state, and carries the declared properties', async () => {
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(
      deps,
      provider({
        attachments: [
          { kind: 'license', issuer: 'TX Medical Board', state: 'TX', expires_at: '2027-03-31' },
          { kind: 'license', issuer: 'CA Medical Board', state: 'CA', expires_at: '2028-01-31' },
        ],
      }),
    );
    const rows = await deps.db.select().from(attachments).where(eq(attachments.recordId, record_id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.properties !== null)).toBe(true);
  });

  it('refuses an attachment kind no loaded pack declares', async () => {
    const deps = makeTestDeps(db);
    await expect(upsertRecord(deps, provider({ attachments: [{ kind: 'epic_link' }] }))).rejects.toThrow(
      'no loaded pack declares attachment kind "epic_link"',
    );
  });

  it('refuses a property key that names a restricted identifier, and writes no attachment row', async () => {
    // `properties` is plaintext jsonb with no per-entry restricted flag and no masked read-back,
    // so the only way to keep "restricted values live only in bytea" is to refuse the key.
    const deps = makeTestDeps(db);
    const restricted = provider({
      attachments: [{ kind: 'license', issuer: 'TX Medical Board', properties: { 'DEA-Number': 'BX1234563' } }],
    });
    await expect(upsertRecord(deps, restricted)).rejects.toThrow(ToolError);
    await expect(upsertRecord(deps, restricted)).rejects.toThrow(
      'attachment property "DEA-Number" names a restricted identifier',
    );
    const rows = await deps.db.select().from(attachments);
    expect(rows.filter((r) => JSON.stringify(r.properties).includes('BX1234563'))).toEqual([]);
  });

  it('keeps a property key the restricted-name rule does not recognise', async () => {
    // The guard is a name rule, not a ban on properties: `npi` and `deadline` are not restricted
    // and an attachment kind's declared bag has to keep working.
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(
      deps,
      provider({ attachments: [{ kind: 'license', issuer: 'TX Medical Board', properties: { npi: '1234567890' } }] }),
    );
    const rows = await deps.db.select().from(attachments).where(eq(attachments.recordId, record_id));
    expect(rows[0]?.properties).toEqual({ npi: '1234567890' });
  });
});

describe('readRecord, searchRecords and listPendingFields', () => {
  it('scopes every read to the client and reports a foreign record as not found', async () => {
    const mine = makeTestDeps(db, { client: 'a' });
    const theirs = makeTestDeps(db, { client: 'b' });
    const { record_id } = await upsertRecord(mine, provider());
    await expect(requireRecord(theirs, record_id)).rejects.toThrow(`record ${record_id} not found`);
  });

  it('searches on a name fragment, on an exact external id, and on both at once', async () => {
    const deps = makeTestDeps(db);
    await upsertRecord(deps, provider());
    expect((await searchRecords(deps, { name: 'reyes' })).records).toHaveLength(1);
    expect((await searchRecords(deps, { external_id: '1234567890' })).records).toHaveLength(1);
    expect((await searchRecords(deps, { name: 'zzz', external_id: '1234567890' })).records).toHaveLength(1);
    expect((await searchRecords(deps, { kind: 'provider', name: 'reyes' })).records[0]).toMatchObject({
      kind: 'provider',
      name: 'Ada Reyes',
      external_id: '1234567890',
    });
  });

  it('lists only the fields still waiting on a human', async () => {
    const deps = makeTestDeps(db);
    const { record_id } = await upsertRecord(
      deps,
      provider({ fields: [{ name: 'specialty', value: 'x', confidence: 0.1 }] }),
    );
    expect((await listPendingFields(deps, record_id)).fields.map((f) => f.name)).toEqual(['specialty']);
  });
});
