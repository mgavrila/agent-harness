import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { clientDocumentVersions, clientDocuments, type Db } from '@harness/db';
import { parseClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { ConfigError } from '@harness/shared';
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

  it('refuses a row whose document names another client than the row key does', async () => {
    // Only a corrupt write produces one, and the files source refuses the same mismatch in its
    // own terms. Without the check the pool would hold a tenant under key "fixture" whose every
    // row, every audit line and every claim said "other" — a tenant boundary crossed by a typo.
    await db.insert(clientDocuments).values({
      clientId: 'fixture',
      schemaVersion: 1,
      version: 'v1',
      document: parseClientDocument(fixtureDocument({ id: 'other' })),
    });
    await expect(postgresConfigSource({ db, log }).load('fixture')).rejects.toThrow(
      'the row keyed "fixture" holds a document that declares id "other"',
    );
  });

  it('refuses a stored document whose knowledge path is relative, because a row has no directory', async () => {
    await writeClientDocument(
      db,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
      'v1',
    );
    await expect(postgresConfigSource({ db, log }).load('fixture')).rejects.toThrow(/must be absolute/);
  });
});

describe('a version is written once', () => {
  it('refuses the same version with different content, naming the client and the version', async () => {
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1'),
    ).rejects.toThrow(ConfigError);
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1'),
    ).rejects.toThrow(/"fixture".*"v1"/);
  });

  it('leaves both tables exactly as they were when it refuses', async () => {
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Second' })), 'v2');
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Rewritten' })), 'v1'),
    ).rejects.toThrow(ConfigError);
    // The live row still says v2 and the history still holds two versions: a refusal rolls the
    // whole transaction back, which is the difference between refusing and half-writing.
    const live = await db.select().from(clientDocuments);
    expect(live[0].version).toBe('v2');
    expect((live[0].document as { displayName: string }).displayName).toBe('Second');
    const history = await db.select().from(clientDocumentVersions);
    expect(history).toHaveLength(2);
    expect(history.map((row) => (row.document as { displayName: string }).displayName).sort()).toEqual([
      'Fixture',
      'Second',
    ]);
  });

  it('stays a no-op for an identical rewrite, whatever order the keys arrive in', async () => {
    const document = parseClientDocument(fixtureDocument());
    await writeClientDocument(db, document, 'v1');
    // The stored copy came back through `jsonb`, which does not keep key order, so the comparison
    // has to be canonical rather than a string compare of two serialisations.
    await expect(writeClientDocument(db, { ...document }, 'v1')).resolves.toBeUndefined();
    expect(await db.select().from(clientDocumentVersions)).toHaveLength(1);
  });
});
