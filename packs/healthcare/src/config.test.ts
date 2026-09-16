import { afterEach, describe, expect, it, vi } from 'vitest';
import { NPPES_DEFAULT_BASE_URL } from './domain/verify/nppes.js';
import { verifyConfigFromEnv } from './config.js';

/**
 * The registry endpoint is the one variable here that has a default and must still refuse an
 * empty value: `optionalEnv` reads an empty string as absent, so a half-filled `.env` would
 * point the lookup at the live CMS registry without saying so. This assertion used to live in
 * `core-tools`' `app/server.test.ts`, beside the `envOrDefault` that read the variable; the
 * variable is the pack's now, so the check moved with it.
 */
afterEach(() => vi.unstubAllEnvs());

describe('verifyConfigFromEnv', () => {
  it('refuses an empty NPPES_BASE_URL rather than falling back to the live CMS registry', () => {
    vi.stubEnv('NPPES_BASE_URL', '');
    expect(() => verifyConfigFromEnv()).toThrow(/NPPES_BASE_URL/);
    vi.stubEnv('NPPES_BASE_URL', undefined);
    expect(verifyConfigFromEnv().nppesBaseUrl).toBe(NPPES_DEFAULT_BASE_URL);
  });
});
