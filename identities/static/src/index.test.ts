import { describe, expect, it } from 'vitest';
import { ConfigError, type Logger } from '@harness/shared';
import { parseIdentityFileWithDefaults, type IdentityFile } from '@harness/identity-api';
import { identity } from './index.js';

const log: Logger = { info() {}, warn() {}, error() {} };

const PRINCIPALS = [
  { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U0456EFGH' } },
  { id: 'svc-local', kind: 'service', level: 'service', displayName: 'Local operator' },
];

function file(extra: Record<string, unknown> = {}): IdentityFile {
  return parseIdentityFileWithDefaults({ principals: PRINCIPALS, ...extra });
}

const connect = (identityFile: IdentityFile, logger = log) =>
  identity.connect({ env: {}, log: logger, identity: identityFile, settings: {}, directories: {} });

describe('the static identity plug-in', () => {
  it('declares itself the way every plug-in does, and reads no environment variable', () => {
    expect(identity.name).toBe('static');
    expect(identity.secrets).toEqual([]);
  });

  it('answers for the principals the document declares', async () => {
    const session = await connect(file());
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    expect(await session.get('svc-local')).toMatchObject({ kind: 'service' });
    expect(await session.get('u-nobody')).toBeNull();
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('gives an undeclared user the level its surface defaults to, under an id derived from theirs', async () => {
    const session = await connect(file({ defaults: { memory: 'member' } }));
    const minted = await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' });
    expect(minted).toEqual({
      id: 'u-memory-u0c0keb8w3x-6774a381',
      kind: 'user',
      level: 'member',
      displayName: 'U0C0KEB8W3X',
      surfaces: { memory: 'U0C0KEB8W3X' },
      attributes: {},
    });
    // The same person is the same principal on the next turn, and on the next process.
    expect(await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' })).toEqual(minted);
    expect(await session.get('u-memory-u0c0keb8w3x-6774a381')).toEqual(minted);
  });

  it('leaves a declared principal alone, and names only the newly minted ones in the log', async () => {
    const lines: string[] = [];
    const session = await connect(file({ defaults: { memory: 'member' } }), {
      ...log,
      info: (message: string) => lines.push(message),
    });
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    await session.resolve({ surface: 'memory', userId: 'U9' });
    await session.resolve({ surface: 'memory', userId: 'U9' });
    expect(lines.filter((line) => line.includes('u-memory-u9-c5f6f2a2'))).toHaveLength(1);
    // `list()` stays the document's own answer: what was declared, in the order it was declared.
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('still refuses an undeclared user when the document names no default at all', async () => {
    const session = await connect(file());
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
  });

  it('still refuses an undeclared user on a surface the defaults leave out', async () => {
    const session = await connect(file({ defaults: { memory: 'member' } }));
    expect(await session.resolve({ surface: 'http', userId: 'nobody' })).toBeNull();
  });

  it('answers for a principal a previous process minted, which is where an approval outlives a restart', async () => {
    const first = await connect(file({ defaults: { memory: 'member' } }));
    const minted = await first.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' });
    await first.stop();

    // A second session over the same document, having minted nothing: the approval raised before
    // the restart names its requester by id, and that id has to resolve to the same person.
    const second = await connect(file({ defaults: { memory: 'member' } }));
    const recovered = await second.get(minted?.id ?? '');
    expect(recovered?.id).toBe(minted?.id);
    expect(recovered?.level).toBe('member');
    expect(recovered?.kind).toBe('user');
    // An id of the same shape on a surface the document gives no default is still nobody.
    expect(await second.get('u-http-someone-deadbeef')).toBeNull();
    expect(await second.get('u-memory-nobody')).toBeNull();
  });

  it('refuses a caller whose derived id is already declared, and says so once', async () => {
    // `U9` on `memory` derives `u-memory-u9-c5f6f2a2`. Declaring that id outright would otherwise
    // hand whoever holds it the declared principal's memory, approvals and audit trail.
    const warnings: string[] = [];
    const collides = file({
      defaults: { memory: 'member' },
      principals: [
        ...PRINCIPALS,
        { id: 'u-memory-u9-c5f6f2a2', kind: 'user', level: 'admin', displayName: 'Someone else' },
      ],
    });
    const session = await connect(collides, { ...log, warn: (message: string) => warnings.push(message) });

    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(warnings).toEqual([
      'static identity: derived id "u-memory-u9-c5f6f2a2" is already declared; refusing the caller',
    ]);
    // The declared principal is untouched, and everyone else on the surface still gets a default.
    expect((await session.get('u-memory-u9-c5f6f2a2'))?.level).toBe('admin');
    expect((await session.resolve({ surface: 'memory', userId: 'U8' }))?.level).toBe('member');
  });

  it('refuses a document that defaults the run API surface, whatever level it names', () => {
    expect(() => file({ defaults: { http: 'member' } })).toThrow(ConfigError);
    expect(() => file({ defaults: { http: 'member' } })).toThrow(/"http" may not have a default/);
  });

  it('refuses a document that defaults a surface to the service level', () => {
    expect(() => file({ defaults: { memory: 'service' } })).toThrow(ConfigError);
  });
});
