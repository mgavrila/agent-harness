import { describe, expect, it } from 'vitest';
import { NPPES_DEFAULT_BASE_URL } from './domain/verify/nppes.js';
import { verifyConfigFromEnv } from './config.js';

/**
 * Every assertion here passes a map. That is the point of the parameter: the pack is configured
 * by whoever built its dependency bag, so nothing it reads can be changed by the environment of
 * the process the tests happen to run in — and this file needs no environment stubbing to say
 * so.
 */
describe('verifyConfigFromEnv', () => {
  it('reads the four variables out of the map it is handed, not out of the process', () => {
    const config = verifyConfigFromEnv({
      VERIFY_NPPES_ENABLED: 'true',
      NPPES_BASE_URL: 'http://127.0.0.1:1/api/',
      VERIFY_STATE_LICENSE_ENABLED: 'true',
      VERIFY_TIMEOUT_MS: '2000',
    });
    expect(config).toEqual({
      nppesEnabled: true,
      nppesBaseUrl: 'http://127.0.0.1:1/api/',
      stateLicenseEnabled: true,
      timeoutMs: 2_000,
    });
  });

  it('switches every outbound lookup off for an empty environment', () => {
    const config = verifyConfigFromEnv({});
    expect(config.nppesEnabled).toBe(false);
    expect(config.stateLicenseEnabled).toBe(false);
    expect(config.timeoutMs).toBe(15_000);
  });

  /**
   * The registry endpoint is the one variable here that has a default and must still refuse an
   * empty value: `optionalEnv` reads an empty string as absent, so a half-filled `.env` would
   * point the lookup at the live CMS registry without saying so. This assertion used to live in
   * `core-tools`' `app/server.test.ts`, beside the `envOrDefault` that read the variable; the
   * variable is the pack's now, so the check moved with it.
   */
  it('refuses an empty NPPES_BASE_URL rather than falling back to the live CMS registry', () => {
    expect(() => verifyConfigFromEnv({ NPPES_BASE_URL: '' })).toThrow(/NPPES_BASE_URL/);
    expect(verifyConfigFromEnv({}).nppesBaseUrl).toBe(NPPES_DEFAULT_BASE_URL);
  });
});
