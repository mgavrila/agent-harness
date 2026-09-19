import { describe, expect, it } from 'vitest';
import { ConfigError, type SurfaceDirectory } from '@harness/shared';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { identity } from './index.js';

const log = { info() {}, warn() {}, error() {} };

function directory(groups: Record<string, string[]>, names: Record<string, string> = {}): SurfaceDirectory {
  return {
    groupsOf: async (userId) => groups[userId] ?? [],
    displayNameOf: async (userId) => names[userId] ?? null,
  };
}

const file = (extra: Record<string, unknown> = {}) =>
  parseIdentityFileWithDefaults({
    principals: [{ id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' }],
    ...extra,
  });

const settings = {
  surface: 'slack',
  groups: [
    { id: 'S-ADMINS', level: 'admin' },
    { id: 'S-LEADS', level: 'lead' },
    { id: 'S-STAFF', level: 'practitioner' },
  ],
  exceptions: [
    { userId: 'U-CONTRACTOR', level: 'member' },
    { userId: 'U-BANNED', level: 'refuse' },
  ],
  sync: { everySeconds: 300 },
};

const connect = (directories: Record<string, SurfaceDirectory>, extra: Record<string, unknown> = {}) =>
  identity.connect({
    env: {},
    log,
    identity: file({ defaults: { slack: 'member' } }),
    settings: { ...settings, ...extra },
    directories,
  });

describe('the slack-groups identity plug-in', () => {
  it('declares itself, and reads no environment variable of its own', () => {
    expect(identity.name).toBe('slack-groups');
    expect(identity.secrets).toEqual([]);
  });

  it("gives a member of a group that group's level, under a derived id and the directory's name", async () => {
    const session = await connect({ slack: directory({ 'U-LEAD': ['S-LEADS'] }, { 'U-LEAD': 'Ada Lovelace' }) });
    const principal = await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    expect(principal).toMatchObject({ level: 'lead', displayName: 'Ada Lovelace', kind: 'user' });
    expect(principal?.id).toMatch(/^u-slack-u-lead-[0-9a-f]{8}$/);
    // The same person is the same principal, and `get` answers for them.
    expect(await session.get(principal!.id)).toEqual(principal);
  });

  it('takes the first matching group in the order the document lists them', async () => {
    const session = await connect({ slack: directory({ 'U-BOTH': ['S-STAFF', 'S-ADMINS'] }) });
    expect((await session.resolve({ surface: 'slack', userId: 'U-BOTH' }))?.level).toBe('admin');
  });

  it('lets an exception beat a group, and a refusal beat everything', async () => {
    const session = await connect({
      slack: directory({ 'U-CONTRACTOR': ['S-ADMINS'], 'U-BANNED': ['S-ADMINS'] }),
    });
    expect((await session.resolve({ surface: 'slack', userId: 'U-CONTRACTOR' }))?.level).toBe('member');
    expect(await session.resolve({ surface: 'slack', userId: 'U-BANNED' })).toBeNull();
  });

  it("falls to the document's default for someone in no group, and refuses when there is none", async () => {
    const withDefault = await connect({ slack: directory({}) });
    expect((await withDefault.resolve({ surface: 'slack', userId: 'U-NEW' }))?.level).toBe('member');

    const noDefault = await identity.connect({
      env: {},
      log,
      identity: file(),
      settings,
      directories: { slack: directory({}) },
    });
    expect(await noDefault.resolve({ surface: 'slack', userId: 'U-NEW' })).toBeNull();
  });

  it('still answers for a declared principal first, whatever the directory says', async () => {
    const declared = parseIdentityFileWithDefaults({
      defaults: { slack: 'member' },
      principals: [
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
        { id: 'u-owner', kind: 'user', level: 'admin', displayName: 'Owner', surfaces: { slack: 'U-OWNER' } },
      ],
    });
    const session = await identity.connect({
      env: {},
      log,
      identity: declared,
      settings,
      directories: { slack: directory({ 'U-OWNER': ['S-STAFF'] }) },
    });
    expect((await session.resolve({ surface: 'slack', userId: 'U-OWNER' }))?.id).toBe('u-owner');
  });

  it('asks the directory once per sync window, not once per message', async () => {
    let calls = 0;
    const counting: SurfaceDirectory = {
      groupsOf: async () => {
        calls += 1;
        return ['S-LEADS'];
      },
      displayNameOf: async () => null,
    };
    const session = await connect({ slack: counting }, { sync: { everySeconds: 3600 } });
    await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    expect(calls).toBe(1);
  });

  it('shapes a display name the directory handed it, because it is rendered into a rules block', async () => {
    const session = await connect({ slack: directory({ 'U-X': ['S-LEADS'] }, { 'U-X': 'Ada\nLovelace' }) });
    expect((await session.resolve({ surface: 'slack', userId: 'U-X' }))?.displayName).toBe('AdaLovelace');
  });

  it('refuses a document whose settings are not settings, naming the field', async () => {
    await expect(
      identity.connect({ env: {}, log, identity: file(), settings: { surface: 'slack' }, directories: {} }),
    ).rejects.toThrow(ConfigError);
    await expect(identity.connect({ env: {}, log, identity: file(), settings, directories: {} })).rejects.toThrow(
      /no surface named "slack" offers a directory/,
    );
  });

  it('answers nothing on a surface it was not configured for', async () => {
    const session = await connect({ slack: directory({ U1: ['S-LEADS'] }) });
    expect(await session.resolve({ surface: 'memory', userId: 'U1' })).toBeNull();
  });
});
