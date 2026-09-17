import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineIdentityProvider, levelAtLeast } from './identity.js';
import type { IdentityProvider } from './types.js';

const stub: IdentityProvider = {
  name: 'static',
  version: '0.1.0',
  secrets: [],
  connect: () => Promise.reject(new Error('not connected in this test')),
};

describe('defineIdentityProvider', () => {
  it('returns the declaration unchanged when it is well formed', () => {
    expect(defineIdentityProvider(stub)).toBe(stub);
  });

  it('refuses a name that is not a lowercase identifier', () => {
    expect(() => defineIdentityProvider({ ...stub, name: 'Static' })).toThrow(ConfigError);
    expect(() => defineIdentityProvider({ ...stub, name: 'Static' })).toThrow(/identity plug-in name "Static"/);
  });

  it('refuses a declaration with no version', () => {
    expect(() => defineIdentityProvider({ ...stub, version: '  ' })).toThrow(/has no version/);
  });

  it('refuses a secret that is not an environment variable name, and a repeated one', () => {
    expect(() => defineIdentityProvider({ ...stub, secrets: ['tenant_secret'] })).toThrow(/"tenant_secret"/);
    expect(() => defineIdentityProvider({ ...stub, secrets: ['A_SECRET', 'A_SECRET'] })).toThrow(/twice/);
  });
});

describe('levelAtLeast', () => {
  it('orders the four user levels cumulatively', () => {
    expect(levelAtLeast('admin', 'member')).toBe(true);
    expect(levelAtLeast('lead', 'lead')).toBe(true);
    expect(levelAtLeast('practitioner', 'lead')).toBe(false);
    expect(levelAtLeast('member', 'admin')).toBe(false);
  });

  it('never treats a service as at least a user level, in either direction', () => {
    expect(levelAtLeast('service', 'member')).toBe(false);
    expect(levelAtLeast('service', 'admin')).toBe(false);
    expect(levelAtLeast('admin', 'service')).toBe(false);
    expect(levelAtLeast('service', 'service')).toBe(true);
  });
});
