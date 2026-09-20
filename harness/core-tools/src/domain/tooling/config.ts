import path from 'node:path';
import type { ClientDocument } from '@harness/config-api';
import { loadKey } from '@harness/db';
import { booleanFromEnv, numberFromEnv, optionalEnv, type EnvSource } from '@harness/shared';
import { localParser, remoteParser } from '../documents/parser.js';
import type { DocumentParser } from '../documents/types.js';
import { gatewayFromEnv } from '../models/gateway.js';
import { loadPacks } from '../packs/registry.js';
import type { PackRegistry } from '../packs/types.js';
import { storageRoot } from '../storage/layout.js';
import type { KernelConfig } from './deps.js';
import { DEFAULT_POLICY, mergePolicy } from './policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD } from './types.js';

/**
 * Where the form templates live.
 *
 * The pack owns them, so the primary pack's own directory — the first pack the client document's
 * `packs` list names — is the answer for every deployment that has not said otherwise, and
 * swapping the pack swaps the templates with it. `HARNESS_FORMS_DIR` is an explicit override for a
 * deployment that keeps its templates somewhere else; set, it wins and is resolved against the
 * process working directory, exactly as it did before the registry existed. The directory is read
 * off the pack here rather than through `registry.formsDir()`, which answers a stricter question —
 * *that* pack's directory or a `ConfigError` — and so has no answer to start a deployment with.
 *
 * `formsDir` is optional on the pack contract, and a primary pack that declares none — or no
 * primary pack at all, which is a client with no pack — leaves nothing to answer with. The
 * storage directory stands in there, the same stand-in the eval pipeline uses for a measured pack
 * that ships no templates. Nothing reads the value in that deployment: `deps.formsDir` has one
 * consumer, the healthcare pack's forms tools, and a pack that ships forms tools ships a
 * `formsDir` with them. The cost is that such a pack, having forgotten one, no longer fails at
 * startup; what it loses is a loud failure over a directory nothing would have opened, and what
 * it buys is that a document naming `@harness/pack-stories` alone starts at all.
 */
export function formsDirFrom(packs: Pick<PackRegistry, 'all'>, raw: string | undefined, storageDir: string): string {
  if (raw) return path.resolve(raw);
  return packs.all[0]?.formsDir ?? storageDir;
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
 * Everything every run shares, read and loaded once per tenant.
 *
 * The **document** decides what this client is — its id, its policy, its packs, where its
 * knowledge is — and the **environment** decides what this deployment is: where files live, which
 * key encrypts them, which gateway to call. Nothing here reads the ambient environment, and
 * nothing here resolves a path from where this file happens to sit: both are what stopped one
 * process from serving two clients.
 */
export async function buildKernelConfig(document: ClientDocument, env: EnvSource): Promise<KernelConfig> {
  const packs = await loadPacks(document.packs);
  // One root for the whole file store, required and with no default (see storageRoot).
  const storageDir = storageRoot(env);

  return {
    client: document.id,
    policy: mergePolicy(DEFAULT_POLICY, document.policy),
    hiddenTools: document.policy.tools.hide,
    encryptionKey: loadKey(env),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }, env),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }, env),
    gateway: gatewayFromEnv(env),
    storageDir,
    knowledgeDir: document.knowledge.source === 'dir' ? document.knowledge.path : null,
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
