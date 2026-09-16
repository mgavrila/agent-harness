import { describe, expect, it } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { definePack } from '@harness/pack-api';
import { registryOf } from '../domain/packs/registry.js';
import { connectTools, makeTestDeps, resultOf, textOf, useTestDb } from '../testing.js';
import { recordTools } from './records.js';

const db = useTestDb();

/** The shipped pack with its record kind opted back in, so the generic tools have a kind to serve. */
const generic = definePack({
  ...healthcarePack,
  records: healthcarePack.records.map((r) => ({ ...r, genericTools: true })),
});

describe('records_* over a declared kind', () => {
  it('stores, reads back and searches a record, with the restricted value masked', async () => {
    const packs = registryOf([generic]);
    const deps = makeTestDeps(db, { packs });
    const client = await connectTools('records-test', recordTools(packs), deps);

    const upserted = resultOf<{ record_id: string; fields_extracted: number; attachments: number }>(
      await client.callTool({
        name: 'records_upsert',
        arguments: {
          kind: 'provider',
          name: 'Ada Reyes',
          external_id: '1234567890',
          fields: [
            { name: 'specialty', value: 'Family Medicine', confidence: 0.99 },
            { name: 'ssn', value: '123-45-6789' },
          ],
          attachments: [{ kind: 'license', issuer: 'TX Medical Board', state: 'TX', expires_at: '2027-03-31' }],
        },
      }),
    );
    expect(upserted.fields_extracted).toBe(2);
    expect(upserted.attachments).toBe(1);

    const read = resultOf<{ record: { kind: string }; fields: { name: string; value: string | null }[] }>(
      await client.callTool({ name: 'records_get', arguments: { record_id: upserted.record_id } }),
    );
    expect(read.record.kind).toBe('provider');
    expect(read.fields.find((f) => f.name === 'ssn')?.value).toBe('[restricted]');
    expect(read.fields.find((f) => f.name === 'ssn')?.value).not.toContain('123');

    const found = resultOf<{ records: { record_id: string }[] }>(
      await client.callTool({ name: 'records_search', arguments: { kind: 'provider', name: 'reyes' } }),
    );
    expect(found.records.map((r) => r.record_id)).toEqual([upserted.record_id]);
  });

  it('refuses a kind the loaded packs do not declare, at the schema, before any handler runs', async () => {
    const packs = registryOf([generic]);
    const deps = makeTestDeps(db, { packs });
    const client = await connectTools('records-test', recordTools(packs), deps);
    const res = await client.callTool({ name: 'records_upsert', arguments: { kind: 'epic', name: 'x' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('kind');
  });
});
