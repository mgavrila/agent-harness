import { describe, expect, it, vi } from 'vitest';
import { ConfigError, type Logger, type SurfaceDirectory } from '@harness/shared';
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

const connect = (
  identityFile: IdentityFile,
  logger = log,
  directories: Readonly<Record<string, SurfaceDirectory>> = {},
) => identity.connect({ env: {}, log: logger, identity: identityFile, settings: {}, directories });

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

describe('a name for somebody the document never declared', () => {
  /** A directory that keeps every user id it was asked about, so a case can count the requests. */
  const directory = (names: Record<string, string | null>, fail = false): SurfaceDirectory & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      groupsOf: async () => [],
      displayNameOf: async (userId: string) => {
        asked.push(userId);
        if (fail) throw new Error('missing_scope');
        return names[userId] ?? null;
      },
    };
  };

  it('names a minted principal what the surface calls them', async () => {
    const session = await connect(file({ defaults: { slack: 'member' } }), log, {
      slack: directory({ U1: 'Ada Lovelace' }),
    });
    const principal = await session.resolve({ surface: 'slack', userId: 'U1' });
    expect(principal).toMatchObject({ level: 'member', displayName: 'Ada Lovelace' });
    // The id is still derived from the surface user id, so the same person is the same principal
    // tomorrow and in the next process: a name is cosmetic and an id is not.
    expect(principal?.surfaces).toEqual({ slack: 'U1' });
  });

  it('falls back to the surface user id when the directory will not say', async () => {
    const session = await connect(file({ defaults: { slack: 'member' } }), log, { slack: directory({ U1: null }) });
    expect((await session.resolve({ surface: 'slack', userId: 'U1' }))?.displayName).toBe('U1');
  });

  it('keeps the level when the directory refuses, and says so once', async () => {
    const warn = vi.fn();
    const session = await connect(
      file({ defaults: { slack: 'member' } }),
      { ...log, warn },
      {
        slack: directory({}, true),
      },
    );
    const principal = await session.resolve({ surface: 'slack', userId: 'U1' });
    // A workspace that will not say what somebody is called does not cost them the level the
    // document already gave them — the same ruling `identities/slack-groups` follows.
    expect(principal).toMatchObject({ level: 'member', displayName: 'U1' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('mints without a directory at all, which is every surface that has none', async () => {
    const session = await connect(file({ defaults: { memory: 'member' } }), log, {});
    expect((await session.resolve({ surface: 'memory', userId: 'U9' }))?.displayName).toBe('U9');
  });

  it('asks the workspace once per principal, however many messages that person sends', async () => {
    const slack = directory({ U1: 'Ada Lovelace' });
    const session = await connect(file({ defaults: { slack: 'member' } }), log, { slack });
    const first = await session.resolve({ surface: 'slack', userId: 'U1' });
    expect(await session.resolve({ surface: 'slack', userId: 'U1' })).toEqual(first);
    // The derived id comes from the surface and the user id alone, so the minted principal can be
    // found again without a name: the lookup belongs behind that cache, not in front of it.
    expect(slack.asked).toEqual(['U1']);
  });

  it('asks a refusing workspace once too, rather than once per message', async () => {
    const warn = vi.fn();
    const slack = directory({}, true);
    const session = await connect(file({ defaults: { slack: 'member' } }), { ...log, warn }, { slack });
    expect((await session.resolve({ surface: 'slack', userId: 'U1' }))?.displayName).toBe('U1');
    expect((await session.resolve({ surface: 'slack', userId: 'U1' }))?.displayName).toBe('U1');
    // A workspace missing `users:read` answers nothing, for every message, for the life of the
    // process. The minted principal is the cached answer, and one line says so once.
    expect(slack.asked).toEqual(['U1']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never asks about a caller whose derived id a declared principal already holds', async () => {
    const memory = directory({ U9: 'Someone' });
    const collides = file({
      defaults: { memory: 'member' },
      principals: [
        ...PRINCIPALS,
        { id: 'u-memory-u9-c5f6f2a2', kind: 'user', level: 'admin', displayName: 'Someone else' },
      ],
    });
    const session = await connect(collides, { ...log, warn() {} }, { memory });
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    // A caller who is about to be refused is not worth a request to the workspace.
    expect(memory.asked).toEqual([]);
  });
});
