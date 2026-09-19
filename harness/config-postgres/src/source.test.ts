import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { clientDocuments, type Db } from '@harness/db';
import { parseClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { postgresConfigSource, writeClientDocument } from './source.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

/**
 * A database whose next transaction's second `insert` throws, the way a real constraint
 * violation would. Everything before it runs for real against the test database, and so does the
 * rollback — this only forces the failure `writeClientDocument`'s history insert should
 * occasionally hit for real (a constraint violation, a dropped connection) so the test can assert
 * on the rollback without depending on which constraint happens to be handy.
 */
function failSecondInsert(real: Db): Db {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (fn: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) => {
            let calls = 0;
            const poisoned = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === 'insert') {
                  calls += 1;
                  if (calls === 2) {
                    return () => {
                      throw new Error('simulated constraint violation');
                    };
                  }
                }
                return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
              },
            });
            return fn(poisoned);
          });
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

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

  it('leaves the live row untouched when the history insert fails', async () => {
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    await expect(
      writeClientDocument(failSecondInsert(db), parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2'),
    ).rejects.toThrow('simulated constraint violation');
    const rows = await db.select().from(clientDocuments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 'v1' });
    expect((rows[0].document as { displayName: string }).displayName).toBe('Fixture');
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
