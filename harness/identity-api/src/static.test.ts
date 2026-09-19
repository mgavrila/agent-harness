import { describe, expect, it } from 'vitest';
import { StaticIdentity } from './testing.js';
import type { Principal } from './types.js';
// Through the public API on purpose, so `index.ts` has an importer inside this package and
// dependency-cruiser's `no-orphans` rule does not flag it.
import { levelAtLeast } from './index.js';

const manager: Principal = {
  id: 'u-practice-manager',
  kind: 'user',
  level: 'admin',
  displayName: 'Practice manager',
  surfaces: { memory: 'U0123ABCD' },
  attributes: {},
};
const nightly: Principal = {
  id: 'svc-playbooks',
  kind: 'service',
  level: 'service',
  displayName: 'Nightly playbooks',
  surfaces: {},
  attributes: {},
};

describe('StaticIdentity', () => {
  const session = new StaticIdentity([manager, nightly]);

  it('names itself static unless told otherwise', () => {
    expect(session.name).toBe('static');
    expect(new StaticIdentity([manager], 'fixture').name).toBe('fixture');
  });

  it('resolves a surface user id to its principal and everyone else to null', async () => {
    expect(await session.resolve({ surface: 'memory', userId: 'U0123ABCD' })).toBe(manager);
    expect(await session.resolve({ surface: 'memory', userId: 'U9999' })).toBeNull();
    // Same user id on a surface the principal was not declared on: still nobody.
    expect(await session.resolve({ surface: 'other', userId: 'U0123ABCD' })).toBeNull();
  });

  it('gets a principal by id and lists them all in declaration order', async () => {
    expect(await session.get('svc-playbooks')).toBe(nightly);
    expect(await session.get('u-nobody')).toBeNull();
    expect(await session.list()).toEqual([manager, nightly]);
    // The resolved principal's level is what a policy decision reads.
    expect(levelAtLeast(manager.level, 'lead')).toBe(true);
  });

  it('flags itself stopped, so a host test can prove it ran the lifecycle', async () => {
    const own = new StaticIdentity([manager]);
    expect(own.stopped).toBe(false);
    await own.stop();
    expect(own.stopped).toBe(true);
  });
});
