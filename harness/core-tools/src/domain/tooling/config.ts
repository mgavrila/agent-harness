import path from 'node:path';
import { loadKey } from '@harness/db';
import { booleanFromEnv, envOrDefault, numberFromEnv, optionalEnv, type EnvSource } from '@harness/shared';
import { localParser, remoteParser } from '../documents/parser.js';
import type { DocumentParser } from '../documents/types.js';
import { gatewayFromEnv } from '../models/gateway.js';
import { loadPacks } from '../packs/registry.js';
import type { PackRegistry } from '../packs/types.js';
import { storageRoot } from '../storage/layout.js';
import type { KernelConfig } from './deps.js';
import { loadPolicy } from './policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD } from './types.js';

/**
 * Where the form templates live.
 *
 * The pack owns them, so `packs.formsDir()` — the first pack named in `HARNESS_PACKS` — is the
 * answer for every deployment that has not said otherwise, and swapping the pack swaps the
 * templates with it. `HARNESS_FORMS_DIR` is an explicit override for a deployment that keeps
 * its templates somewhere else; set, it wins and is resolved against the process working
 * directory, exactly as it did before the registry existed.
 */
export function formsDirFrom(packs: Pick<PackRegistry, 'formsDir'>, raw?: string): string {
  return raw ? path.resolve(raw) : packs.formsDir();
}

/**
 * Which packs this process serves, comma-separated package names. Defaults to the only pack
 * that exists today, so a deployment that sets nothing behaves exactly as it did.
 */
export function packNames(env: EnvSource): string[] {
  return (optionalEnv('HARNESS_PACKS', env) ?? '@harness/pack-healthcare')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * Where documents are parsed. In Compose, `HARNESS_FILES_URL` names the files worker and the
 * bytes never enter this process; unset, the subprocesses run here, which is what a test and a
 * bare-metal developer want.
 */
export function parserFromEnv(storageDir: string, filesUrl?: string): DocumentParser {
  return filesUrl ? remoteParser(filesUrl, storageDir) : localParser(storageDir);
}

/**
 * Everything every run shares, read and loaded once per process. Nothing here is per run:
 * the database handle, the principal and the run context arrive through `depsForRun`.
 */
export async function buildKernelConfig(env: EnvSource): Promise<KernelConfig> {
  const packs = await loadPacks(packNames(env));
  // One root for the whole file store, required and with no default (see storageRoot).
  const storageDir = storageRoot();
  return {
    client: envOrDefault('HARNESS_CLIENT', 'default', env),
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }, env),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }, env),
    gateway: gatewayFromEnv(),
    storageDir,
    parser: parserFromEnv(storageDir, optionalEnv('HARNESS_FILES_URL', env)),
    formsDir: formsDirFrom(packs, optionalEnv('HARNESS_FORMS_DIR', env)),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL', env),
    packs,
    // The deployment's own environment, and the only bag that hands one over. A pack reads its
    // variables from here; see `ToolDeps.env`.
    env,
  };
}
