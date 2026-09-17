import type { AnyToolDef, PackToolDeps } from '@harness/pack-api';
import { verifyConfigFromEnv } from '../config.js';
import { HEALTHCARE_REPLACES, aliasTools } from './aliases.js';
import { formTools } from './forms.js';
import { verifyTools } from './verify.js';

export { HEALTHCARE_REPLACES };

/**
 * The eighteen tools this pack contributes: the six it owns outright, and the twelve wrappers
 * that keep the healthcare tool surface exactly what it was before core became pack-agnostic.
 *
 * Called once per server, from `createCoreToolsServer`, with the live dependency bag. The
 * registry configuration is read here rather than at module load, and out of `deps.env` rather
 * than out of the ambient process environment: a test points `NPPES_BASE_URL` at its own stub
 * by building a bag that says so, and an eval gets the pinned-off map its pipeline hands over.
 */
export function healthcareTools(deps: PackToolDeps): AnyToolDef[] {
  return [...aliasTools(deps), ...formTools(), ...verifyTools(deps, verifyConfigFromEnv(deps.env))];
}
