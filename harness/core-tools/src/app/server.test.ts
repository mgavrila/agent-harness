import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ConfigError } from '@harness/shared';
import { NPPES_DEFAULT_BASE_URL } from '../domain/verify/nppes.js';
import { envOrDefault, formsDirFrom } from './server.js';

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

/**
 * The forms directory belongs to the pack. `HARNESS_FORMS_DIR` is an override a deployment
 * opts into, not a value it has to set, so a client that swaps `HARNESS_PACKS` gets the new
 * pack's templates without editing a second variable.
 */
describe('formsDirFrom', () => {
  const packs = { formsDir: () => '/packs/healthcare/forms' };

  it('takes the pack forms directory when HARNESS_FORMS_DIR is unset, and the override when it is set', () => {
    expect(formsDirFrom(packs, undefined)).toBe('/packs/healthcare/forms');
    expect(formsDirFrom(packs, '/srv/elsewhere/forms')).toBe('/srv/elsewhere/forms');
    expect(formsDirFrom(packs, './forms')).toBe(path.resolve('./forms'));
  });
});
