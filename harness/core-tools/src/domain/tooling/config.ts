import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 *
 * With no pack loaded there is no pack to ask and no forms tool to read the answer — the forms
 * tools are a pack's — so the storage directory stands in, the same stand-in the eval pipeline
 * uses for a measured pack that ships no templates. Asking the registry instead would fail a
 * startup over a directory nothing in that deployment will ever open.
 */
export function formsDirFrom(
  packs: Pick<PackRegistry, 'all' | 'formsDir'>,
  raw: string | undefined,
  storageDir: string,
): string {
  if (raw) return path.resolve(raw);
  return packs.all.length === 0 ? storageDir : packs.formsDir();
}

/** What a deployment that has never heard of `HARNESS_PACKS` serves. */
const DEFAULT_PACKS = '@harness/pack-healthcare';

/**
 * Which packs this process serves, comma-separated package names.
 *
 * Three answers, not two. **Unset** keeps the default, so a deployment that has never set the
 * variable behaves exactly as it did. **Set to a list** serves those packs. **Set to the empty
 * string** serves none: a client whose team wants the kernel's own tools — memory, playbooks,
 * knowledge, approvals, files — and no product area at all. A client is a folder and not code,
 * so having no domain pack has to be something the folder can say.
 *
 * The variable is read here rather than through `optionalEnv`, which reads an empty value as
 * absent and so cannot tell the first case from the third.
 */
export function packNames(env: EnvSource): string[] {
  return (env.HARNESS_PACKS ?? DEFAULT_PACKS)
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

// src/domain/tooling -> src/domain -> src -> core-tools -> harness -> the repository root. The
// same root the image has: node.Dockerfile sets WORKDIR /srv/agent-harness and copies `clients`
// under it, so this resolves to the client folder in a checkout and in a container alike.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** `clients/<name>/`, the folder spec section 7 lays out. */
export function clientDirFor(client: string): string {
  return path.join(repoRoot, 'clients', client);
}

/**
 * Everything every run shares, read and loaded once per process. Nothing here is per run:
 * the database handle, the principal and the run context arrive through `depsForRun`.
 */
export async function buildKernelConfig(env: EnvSource): Promise<KernelConfig> {
  const packs = await loadPacks(packNames(env));
  // One root for the whole file store, required and with no default (see storageRoot).
  const storageDir = storageRoot();

  const client = envOrDefault('HARNESS_CLIENT', 'default', env);
  return {
    client,
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }, env),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }, env),
    gateway: gatewayFromEnv(),
    storageDir,
    clientDir: clientDirFor(client),
    // 1,024 is what migration 0013 created the column at; `assertEmbedDims` is what proves a
    // deployment has not drifted from it. The ceiling is pgvector's own HNSW limit.
    embedDims: numberFromEnv('HARNESS_EMBED_DIMS', 1_024, { min: 8, max: 2_000, integer: true }, env),
    parser: parserFromEnv(storageDir, optionalEnv('HARNESS_FILES_URL', env)),
    formsDir: formsDirFrom(packs, optionalEnv('HARNESS_FORMS_DIR', env), storageDir),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL', env),
    packs,
    // The deployment's own environment, and the only bag that hands one over. A pack reads its
    // variables from here; see `ToolDeps.env`.
    env,
  };
}
