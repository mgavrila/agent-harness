/**
 * External registry lookups.
 *
 * `VerifyRegistry` is the seam: `nppesRegistry(config)` is the production adapter over the
 * public CMS endpoint, and a test double is a plain object with one method — no HTTP stub
 * and no base-URL juggling. `ToolDeps.verify` carries the configuration rather than a built
 * registry, so a test overrides `nppesBaseUrl` exactly as it does today; see ARCHITECTURE.md.
 */
export interface VerifyConfig {
  nppesEnabled: boolean;
  /** Registry endpoint, ending in a slash. Overridden in tests by a local stub. */
  nppesBaseUrl: string;
  stateLicenseEnabled: boolean;
  timeoutMs: number;
}

/**
 * A record the registry returned. Every field but the NPI is nullable,
 * because "the registry holds a record we could not read" and "the registry
 * holds no such NPI" are opposite answers to a credentialing question and
 * must not collapse into one. A record present but missing its enumeration
 * type, its number or its name is reported as found, with nulls where the
 * unreadable parts were.
 */
export interface NppesRecord {
  /** The NPI as the registry echoed it, or null when the record omits it. */
  number: string | null;
  enumerationType: 'NPI-1' | 'NPI-2' | null;
  /** Full name for an individual, organisation name for an organisation. Null when the record does not state one. */
  name: string | null;
  /** 'A' for active. Null when the registry omits it. */
  status: string | null;
  state: string | null;
}

export interface VerifyRegistry {
  /** Null means the registry has no such NPI, which is the expected answer for a synthetic one. */
  lookupNpi(npi: string): Promise<NppesRecord | null>;
}
