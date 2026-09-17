import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineSurface } from './surface.js';
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
