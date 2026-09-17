import path from 'node:path';
import { createDb, loadKey } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { booleanFromEnv, envOrDefault, numberFromEnv, optionalEnv } from '@harness/shared';
import { loadPolicy } from '../domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from '../domain/tooling/types.js';
import { gatewayFromEnv } from '../domain/models/gateway.js';
import { storageRoot } from '../domain/storage/layout.js';
import { PACK_KERNEL } from '../domain/packs/kernel.js';
import { loadPacks } from '../domain/packs/registry.js';
import type { PackRegistry } from '../domain/packs/types.js';

/**
 * Where the form templates live.
 *
 * The pack owns them, so `packs.formsDir()` — the first pack named in `HARNESS_PACKS` — is the
 * answer for every deployment that has not said otherwise, and swapping the pack swaps the
 * templates with it. `HARNESS_FORMS_DIR` is an explicit override for a deployment that keeps
 * its templates somewhere else; set, it wins and is resolved against the process working
 * directory, exactly as it did before the registry existed.
 */
export function formsDirFrom(
  packs: Pick<PackRegistry, 'formsDir'>,
  raw: string | undefined = optionalEnv('HARNESS_FORMS_DIR'),
): string {
  return raw ? path.resolve(raw) : packs.formsDir();
}

/**
 * Which packs this process serves, comma-separated package names. Defaults to the only pack
 * that exists today, so a deployment that sets nothing behaves exactly as it did.
 */
function packNames(): string[] {
  return (optionalEnv('HARNESS_PACKS') ?? '@harness/pack-healthcare')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * The caller name wrapped in a service principal. Transitional: Task 4 of Plan 7 replaces this
 * with a principal resolved from `clients/<name>/identity.yaml` through `HARNESS_PRINCIPAL`.
 */
function callerPrincipal(id: string): Principal {
  return { id, kind: 'service', level: 'service', displayName: id, surfaces: {}, attributes: {} };
}

export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const packs = await loadPacks(packNames());
  const deps: ToolDeps = {
    db,
    client: envOrDefault('HARNESS_CLIENT', 'default'),
    principal: callerPrincipal(envOrDefault('CORE_TOOLS_CALLER', 'hermes')),
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }),
    gateway: gatewayFromEnv(),
    // One root for the whole file store, required and with no default (see
    // storageRoot). Ingested documents live under it as domain/storage lays
    // them out; generated output goes under `<root>/out`.
    storageDir: storageRoot(),
    formsDir: formsDirFrom(packs),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL'),
    sinks: {},
    // One context object per process, shared by every connection this process
    // serves. That is correct for the stdio deployment, where Hermes starts one
    // process per session. A multi-session transport (HTTP) must not reuse this
    // deps object: it has to build one `deps` per session, or one session's run
    // id and skill would be stamped on another session's audit rows.
    context: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    // The deployment's own environment, and the only bag that hands one over. A pack reads its
    // variables from here; see `ToolDeps.env`.
    env: process.env,
  };
  return { deps, close };
}
