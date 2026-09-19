import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { parseClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { postgresConfigSource, writeClientDocument } from './source.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

configSourceConformance(async () => ({
  source: postgresConfigSource({ db, log }),
  // This source serves the version it was handed, so that is the version it assigned.
  put: async (document, version) => {
    await writeClientDocument(db, parseClientDocument(document), version);
    return version;
  },
  close: async () => {},
}));

describe('postgresConfigSource', () => {
  it('keeps every version of a document, not only the live one', async () => {
    const source = postgresConfigSource({ db, log });
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1', 'u-one');
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2', 'u-one');
    expect((await source.load('fixture'))?.version).toBe('v2');
    expect(await source.list?.()).toEqual(['fixture']);
  });

  it('refuses a row that is not a document, rather than half-serving a tenant', async () => {
    await writeClientDocument(db, { ...parseClientDocument(fixtureDocument()), runtime: 'Not A Plug-in' }, 'v1');
    await expect(postgresConfigSource({ db, log }).load('fixture')).rejects.toThrow(/client document is invalid/);
  });

  it('tells a watcher when the version moves, and says nothing while it does not', async () => {
    const source = postgresConfigSource({ db, log, pollMs: 20 });
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    const seen: string[] = [];
    const stop = source.watch?.('fixture', (version) => seen.push(version));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([]);
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2');
    await new Promise((r) => setTimeout(r, 120));
    stop?.();
    expect(seen).toEqual(['v2']);
  });
});
