import { describe, expect, it } from 'vitest';
import { dedicatedResolver, pooledResolver } from './resolver.js';

const keysOf = (clientId: string) =>
  clientId === 'alpha' ? [{ surface: 'slack', key: 'T-ALPHA' }] : [{ surface: 'slack', key: 'T-BETA' }];

describe('dedicatedResolver', () => {
  const resolver = dedicatedResolver('alpha', keysOf);

  it('answers its own client for an event that names no workspace', () => {
    expect(resolver.mode).toBe('dedicated');
    expect(resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBe('alpha');
    expect(resolver.resolve({ from: 'api', clientId: null })).toBe('alpha');
  });

  it('answers its own client for its own workspace', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-ALPHA' })).toBe('alpha');
    expect(resolver.resolve({ from: 'api', clientId: 'alpha' })).toBe('alpha');
  });

  it('refuses any other workspace and any other client id (invariant 19)', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-BETA' })).toBeNull();
    expect(resolver.resolve({ from: 'api', clientId: 'beta' })).toBeNull();
  });
});

describe('pooledResolver', () => {
  const resolver = pooledResolver((surface, key) => (surface === 'slack' && key === 'T-BETA' ? 'beta' : null));

  it('takes the client from the workspace the event names', () => {
    expect(resolver.mode).toBe('pooled');
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-BETA' })).toBe('beta');
  });

  it('takes the client from the run API header, because a caller names it directly', () => {
    expect(resolver.resolve({ from: 'api', clientId: 'beta' })).toBe('beta');
  });

  it('refuses an event that names no workspace, because a pool cannot guess', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBeNull();
    expect(resolver.resolve({ from: 'api', clientId: null })).toBeNull();
  });

  it('refuses a workspace nobody claims', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-NOBODY' })).toBeNull();
  });
});
