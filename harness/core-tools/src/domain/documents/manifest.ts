import { parseManifest as parseManifestWith, type ProviderManifest } from '@harness/pack-api';
import { isRestrictedName } from '../../shared/redaction/names.js';

export { type ManifestCredential, type ManifestField, type ProviderManifest } from '@harness/pack-api';

// Deliberately ordered for the prompt rather than shared with the template
// manifest's list: this order is what the model reads in the schema.
// `@harness/pack-api` keeps its own private copy to validate a manifest's
// `properties` against; this one is what `schema.ts` expands into JSON Schema.
export const CREDENTIAL_PROPERTIES = ['state', 'issuer', 'issued_at', 'expires_at'] as const;

/**
 * Validate a pack's extraction manifest against this build's restricted-name rules. The schema
 * itself lives in `@harness/pack-api` so a pack can be typed against it; the rule that decides
 * which names are encrypted stays here, and is handed in.
 */
export function parseManifest(raw: unknown): ProviderManifest {
  return parseManifestWith(raw, { isRestrictedName });
}
