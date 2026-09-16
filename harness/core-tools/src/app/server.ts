import path from 'node:path';
import { createDb, loadKey } from '@harness/db';
import { booleanFromEnv, numberFromEnv, optionalEnv } from '@harness/shared';
import { loadPolicy } from '../domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from '../domain/tooling/types.js';
import { gatewayFromEnv } from '../domain/models/gateway.js';
import { storageRoot } from '../domain/storage/layout.js';
import { defaultFormsDir } from '../domain/forms/templates.js';
import { NPPES_DEFAULT_BASE_URL } from '../domain/verify/nppes.js';

export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const formsDir = optionalEnv('HARNESS_FORMS_DIR');
  const deps: ToolDeps = {
    db,
    client: optionalEnv('HARNESS_CLIENT') ?? 'default',
    caller: optionalEnv('CORE_TOOLS_CALLER') ?? 'hermes',
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
    formsDir: formsDir ? path.resolve(formsDir) : defaultFormsDir(),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL'),
    verify: {
      nppesEnabled: booleanFromEnv('VERIFY_NPPES_ENABLED'),
      nppesBaseUrl: optionalEnv('NPPES_BASE_URL') ?? NPPES_DEFAULT_BASE_URL,
      stateLicenseEnabled: booleanFromEnv('VERIFY_STATE_LICENSE_ENABLED'),
      timeoutMs: numberFromEnv('VERIFY_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000 }),
    },
    sinks: {},
    // One context object per process, shared by every connection this process
    // serves. That is correct for the stdio deployment, where Hermes starts one
    // process per session. A multi-session transport (HTTP) must not reuse this
    // deps object: it has to build one `deps` per session, or one session's run
    // id and skill would be stamped on another session's audit rows.
    context: {},
    tools: new Map(),
  };
  return { deps, close };
}
