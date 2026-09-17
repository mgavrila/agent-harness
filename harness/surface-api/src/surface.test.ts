import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { ANY_USER, allowsUser, defineSurface, parseAllowedUsers } from './surface.js';
import type { Surface } from './types.js';

const stub: Surface = {
  name: 'demo',
  version: '0.1.0',
  secrets: ['DEMO_TOKEN'],
  connect: () => Promise.reject(new Error('not connected in this test')),
};

describe('defineSurface', () => {
  it('returns the surface unchanged when it is well formed', () => {
    expect(defineSurface(stub)).toBe(stub);
  });

  it('refuses a name that is not a lowercase identifier, because it is a column value', () => {
    expect(() => defineSurface({ ...stub, name: 'Slack' })).toThrow(ConfigError);
    expect(() => defineSurface({ ...stub, name: 'Slack' })).toThrow(/surface name "Slack"/);
  });

  it('refuses a surface with no version', () => {
    expect(() => defineSurface({ ...stub, version: '  ' })).toThrow(/has no version/);
  });

  it('refuses a secret that is not an environment variable name, and a repeated one', () => {
    expect(() => defineSurface({ ...stub, secrets: ['demo_token'] })).toThrow(/"demo_token"/);
    expect(() => defineSurface({ ...stub, secrets: ['A_TOKEN', 'A_TOKEN'] })).toThrow(/twice/);
  });
});

describe('parseAllowedUsers', () => {
  it('splits, trims and drops the empties', () => {
    expect([...parseAllowedUsers(' U012, U345 ,,U678 ')]).toEqual(['U012', 'U345', 'U678']);
  });

  it('turns nothing into the empty set, which is the fail-closed one', () => {
    expect(parseAllowedUsers(undefined).size).toBe(0);
    expect(parseAllowedUsers('').size).toBe(0);
    expect(parseAllowedUsers('  ,  ').size).toBe(0);
  });
});

describe('allowsUser', () => {
  it('fails closed on an empty allowlist, even for a wildcard that is not there', () => {
    expect(allowsUser(new Set(), 'U012')).toBe(false);
  });

  it('allows a listed user and refuses everyone else', () => {
    const allowed = parseAllowedUsers('U012,U345');
    expect(allowsUser(allowed, 'U012')).toBe(true);
    expect(allowsUser(allowed, 'U999')).toBe(false);
  });

  it('allows everyone when the allowlist is the wildcard', () => {
    expect(allowsUser(parseAllowedUsers(ANY_USER), 'anyone-at-all')).toBe(true);
  });
});
