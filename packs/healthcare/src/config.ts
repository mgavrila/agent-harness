import { ConfigError, booleanFromEnv, numberFromEnv } from '@harness/shared';
import { NPPES_DEFAULT_BASE_URL } from './domain/verify/nppes.js';
import type { VerifyConfig } from './domain/verify/types.js';

/**
 * A variable with a default, where an empty value is a mistake rather than a request for that
 * default. `optionalEnv` reads an empty string as absent, so a half-filled `.env` would point
 * the registry lookup at the live CMS endpoint silently, and only fail much later on an
 * outbound path. This is `app/server.ts`'s `envOrDefault`, kept behaviour-identical.
 */
function envOrDefault(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new ConfigError(`${name} is set but empty; give it a value, or unset it to use the default`);
  }
  return raw;
}

/**
 * The pack's registry configuration, read at the moment `tools(deps)` builds the catalogue.
 *
 * These four variables used to be read in core-tools' `app/server.ts` and carried on
 * `ToolDeps.verify`. They are NPPES configuration and NPPES is this pack's business, so the pack
 * reads them. Nothing about `.env.example` changes: the surface test's environment scan already
 * walks `packs/`, so the four names are still documented and still checked.
 */
export function verifyConfigFromEnv(): VerifyConfig {
  return {
    nppesEnabled: booleanFromEnv('VERIFY_NPPES_ENABLED'),
    nppesBaseUrl: envOrDefault('NPPES_BASE_URL', NPPES_DEFAULT_BASE_URL),
    stateLicenseEnabled: booleanFromEnv('VERIFY_STATE_LICENSE_ENABLED'),
    timeoutMs: numberFromEnv('VERIFY_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000 }),
  };
}
