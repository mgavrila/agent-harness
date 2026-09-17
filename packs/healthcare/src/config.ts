import { booleanFromEnv, envOrDefault, numberFromEnv, type EnvSource } from '@harness/shared';
import { NPPES_DEFAULT_BASE_URL } from './domain/verify/nppes.js';
import type { VerifyConfig } from './domain/verify/types.js';

/**
 * The pack's registry configuration, read at the moment `tools(deps)` builds the catalogue.
 *
 * `env` is the map on `deps.env` and never the ambient process environment. A pack that read
 * the ambient one would be configured by whatever process it happened to be loaded into: an
 * eval or a test run on a developer's filled-in `.env` would find `VERIFY_NPPES_ENABLED=true`
 * and the live CMS endpoint, and would make real outbound lookups against a public registry
 * with nobody having asked for them. The caller that builds the dependency bag decides
 * instead, and every caller but the server pins the lookup off.
 *
 * The four variables are still read through `@harness/shared`'s helpers, so they are parsed
 * and worded exactly as the kernel's are, and the environment scan behind `.env.example` still
 * sees all four names.
 */
export function verifyConfigFromEnv(env: EnvSource): VerifyConfig {
  return {
    nppesEnabled: booleanFromEnv('VERIFY_NPPES_ENABLED', env),
    nppesBaseUrl: envOrDefault('NPPES_BASE_URL', NPPES_DEFAULT_BASE_URL, env),
    stateLicenseEnabled: booleanFromEnv('VERIFY_STATE_LICENSE_ENABLED', env),
    timeoutMs: numberFromEnv('VERIFY_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000 }, env),
  };
}
