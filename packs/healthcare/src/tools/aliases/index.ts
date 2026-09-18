/**
 * The healthcare-shaped tool surface, as twelve wrappers over the kernel's generic tools.
 *
 * Every schema in the three modules below is the object the pre-Plan-5 tool declared, copied
 * without an edit: the resolved JSON Schema an MCP client receives is the same bytes, and
 * `docs/architecture/tool-surface.json` is what proves it. Five of the twelve — the `providers_*`
 * names — are renames over `records_*`; the other seven take the kernel's name and are the whole
 * of `HEALTHCARE_REPLACES`.
 */
import type { AnyToolDef, PackToolDeps } from '@harness/pack-api';
import { deadlineAliases } from './deadlines.js';
import { documentAliases } from './documents.js';
import { providerAliases } from './providers.js';

/**
 * The kernel tools this pack takes over: the **seven same-named** ones, and no others.
 *
 * `replaces` removes a name from the published catalogue for the whole process, so it may only
 * carry names this pack genuinely re-publishes under the same name. The five `providers_*`
 * wrappers are *renames* over `records_*`, not replacements, and the five `records_*` names are
 * hidden from a healthcare-only deployment by `genericTools: false` on the `provider` record
 * kind instead (Decision 3). That second mechanism is what lets a second pack loaded beside
 * this one still reach the generic record tools.
 *
 * `COMPAT_REPLACES`, the transitional list this file carried while it still lived in
 * core-tools, did name twelve; it was not a pack, so it had no `genericTools` gate to lean on.
 * Dropping the five here is the whole difference between the two lists, and the surface
 * snapshot proves it costs healthcare nothing: as the catalogues stand today, 22 kernel tools
 * - 7 replaced - 5 gated off + 18 from this pack = the 28 names the snapshot records.
 */
export const HEALTHCARE_REPLACES = [
  'deadlines_compute',
  'deadlines_upcoming',
  'documents_ingest',
  'documents_get',
  'documents_list',
  'documents_classify',
  'documents_extract',
] as const;

/** The twelve wrappers, built once per server from the live dependency bag. */
export function aliasTools(deps: PackToolDeps): AnyToolDef[] {
  return [...providerAliases(deps), ...deadlineAliases, ...documentAliases(deps)];
}
