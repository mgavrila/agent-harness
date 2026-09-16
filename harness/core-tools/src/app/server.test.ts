import { describe, it, expect } from 'vitest';
import { ConfigError } from '@harness/shared';
import { NPPES_DEFAULT_BASE_URL } from '../domain/verify/nppes.js';
import { envOrDefault } from './server.js';

/**
 * The three variables `buildDepsFromEnv` reads with a default. Each one used to go through
 * `optionalEnv`, which reads an empty string as absent, so a half-filled `.env` changed the
 * client, the audited caller or the registry endpoint without saying so.
 */
describe('envOrDefault', () => {
  it('refuses an empty HARNESS_CLIENT rather than serving the default client', () => {
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '' })).toThrow(ConfigError);
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '  ' })).toThrow(/HARNESS_CLIENT/);
    expect(envOrDefault('HARNESS_CLIENT', 'default', {})).toBe('default');
    expect(envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: 'demo-practice' })).toBe('demo-practice');
  });

  it('refuses an empty CORE_TOOLS_CALLER rather than auditing every call as hermes', () => {
    expect(() => envOrDefault('CORE_TOOLS_CALLER', 'hermes', { CORE_TOOLS_CALLER: '' })).toThrow(/CORE_TOOLS_CALLER/);
    expect(envOrDefault('CORE_TOOLS_CALLER', 'hermes', {})).toBe('hermes');
  });

  it('refuses an empty NPPES_BASE_URL rather than falling back to the live CMS registry', () => {
    expect(() => envOrDefault('NPPES_BASE_URL', NPPES_DEFAULT_BASE_URL, { NPPES_BASE_URL: '' })).toThrow(
      /NPPES_BASE_URL/,
    );
    expect(envOrDefault('NPPES_BASE_URL', NPPES_DEFAULT_BASE_URL, {})).toBe(NPPES_DEFAULT_BASE_URL);
  });
});
