import { describe, expect, it } from 'vitest';
import { FakeSlack } from './transport/fake.js';
import { slackDirectory } from './directory.js';

describe('slackDirectory', () => {
  it('answers the groups a user is in, from the two calls it takes to find out', async () => {
    const api = new FakeSlack();
    api.usergroupsList = [{ id: 'S-LEADS' }, { id: 'S-STAFF' }];
    api.usergroupMembers = { 'S-LEADS': ['U1'], 'S-STAFF': ['U1', 'U2'] };
    const directory = slackDirectory(api, { now: () => new Date('2026-09-19T00:00:00Z'), cacheMs: 60_000 });
    expect((await directory.groupsOf('U1')).sort()).toEqual(['S-LEADS', 'S-STAFF']);
    expect(await directory.groupsOf('U2')).toEqual(['S-STAFF']);
    expect(await directory.groupsOf('U9')).toEqual([]);
  });

  it('reads the list once per cache window, not once per caller', async () => {
    const api = new FakeSlack();
    api.usergroupsList = [{ id: 'S-LEADS' }];
    api.usergroupMembers = { 'S-LEADS': ['U1'] };
    let clock = new Date('2026-09-19T00:00:00Z');
    const directory = slackDirectory(api, { now: () => clock, cacheMs: 60_000 });
    await directory.groupsOf('U1');
    await directory.groupsOf('U2');
    expect(api.usergroupsListCalls).toBe(1);
    clock = new Date('2026-09-19T00:02:00Z');
    await directory.groupsOf('U1');
    expect(api.usergroupsListCalls).toBe(2);
  });

  it('answers a display name, and null rather than an empty one', async () => {
    const api = new FakeSlack();
    api.userProfiles = { U1: { real_name: 'Ada Lovelace' }, U2: {}, U3: { real_name: '   ' } };
    const directory = slackDirectory(api, { now: () => new Date(), cacheMs: 60_000 });
    expect(await directory.displayNameOf('U1')).toBe('Ada Lovelace');
    expect(await directory.displayNameOf('U2')).toBeNull();
    expect(await directory.displayNameOf('U3')).toBeNull();
    expect(await directory.displayNameOf('U9')).toBeNull();
  });

  it('raises the workspace refusal by name rather than answering an empty list of groups', async () => {
    const api = new FakeSlack();
    api.failWith = 'missing_scope';
    const directory = slackDirectory(api, { now: () => new Date(), cacheMs: 60_000 });
    await expect(directory.groupsOf('U1')).rejects.toThrow(/missing_scope/);
  });
});
