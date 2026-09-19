import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineRuntime } from './runtime.js';
import type { Runtime } from './types.js';

const session = { name: 'x', run: () => ({ events: (async function* () {})() }), stop: async () => {} };
const base: Runtime = { name: 'scripted', version: '0.1.0', secrets: [], connect: async () => session };

describe('defineRuntime', () => {
  it('returns the declaration unchanged when it is well formed', () => {
    expect(defineRuntime(base)).toBe(base);
  });

  it('refuses a name that is not lowercase letters, digits and hyphens', () => {
    expect(() => defineRuntime({ ...base, name: 'Deep Agents' })).toThrow(ConfigError);
  });

  it('refuses an empty version and a secret that is not an environment variable name', () => {
    expect(() => defineRuntime({ ...base, version: ' ' })).toThrow(/no version/);
    expect(() => defineRuntime({ ...base, secrets: ['api-key'] })).toThrow(/environment variable name/);
    expect(() => defineRuntime({ ...base, secrets: ['A_KEY', 'A_KEY'] })).toThrow(/twice/);
  });
});
