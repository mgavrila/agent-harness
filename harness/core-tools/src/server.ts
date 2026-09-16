import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { DEFAULT_CONFIDENCE_THRESHOLD, registerTools, type ToolDeps } from './registry.js';
import { loadPolicy } from './policy.js';
import { gatewayFromEnv } from './models.js';
import { storageRoot } from './storage.js';
import { defaultFormsDir } from './forms/templates.js';
import { providerTools } from './tools/providers.js';
import { deadlineTools } from './tools/deadlines.js';
import { auditTools } from './tools/audit.js';
import { approvalTools } from './tools/approvals.js';
import { harnessTools } from './tools/harness.js';
import { documentTools } from './tools/documents.js';
import { formTools } from './tools/forms.js';
import { NPPES_DEFAULT_BASE_URL, verifyTools } from './tools/verify.js';

export const ALL_TOOLS = [
  ...providerTools,
  ...deadlineTools,
  ...auditTools,
  ...approvalTools,
  ...harnessTools,
  ...documentTools,
  ...formTools,
  ...verifyTools,
];

export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  registerTools(server, ALL_TOOLS, deps);
  return server;
}

/**
 * Read a numeric environment variable, falling back when it is unset or empty.
 * A present but unparseable or out-of-range value is a configuration error and
 * fails startup rather than silently becoming NaN.
 */
export function numberFromEnv(name: string, fallback: number, { min, max }: { min: number; max: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Read a boolean environment variable. `true` and `1` are on; everything else
 * — unset, empty, `false`, `0`, `no`, a typo — is off. Case and surrounding
 * whitespace are ignored.
 *
 * Every boolean in `buildDepsFromEnv` goes through this one helper so no flag
 * can be read differently from another. Before it, `VERIFY_NPPES_ENABLED`
 * alone disabled on the literal `'false'` while its neighbours enabled on the
 * literal `'true'`, so `VERIFY_NPPES_ENABLED=0` left outbound registry lookups
 * switched on while the same spelling switched everything else off. Every one
 * of these defaults to off: a deployment that sets nothing makes no outbound
 * calls and sends nothing restricted to a model.
 */
export function booleanFromEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const deps: ToolDeps = {
    db,
    client: process.env.HARNESS_CLIENT ?? 'default',
    caller: process.env.CORE_TOOLS_CALLER ?? 'hermes',
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }),
    gateway: gatewayFromEnv(),
    // One root for the whole file store, required and with no default (see
    // storageRoot). Ingested documents live under it as documents/storage.ts
    // lays them out; generated output goes under `<root>/out`.
    storageDir: storageRoot(),
    formsDir: process.env.HARNESS_FORMS_DIR?.trim() ? path.resolve(process.env.HARNESS_FORMS_DIR) : defaultFormsDir(),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL'),
    verify: {
      nppesEnabled: booleanFromEnv('VERIFY_NPPES_ENABLED'),
      nppesBaseUrl: process.env.NPPES_BASE_URL ?? NPPES_DEFAULT_BASE_URL,
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

export {
  registerTools,
  defineTool,
  ToolError,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type ToolDeps,
  type AnyToolDef,
} from './registry.js';
export {
  callModel,
  callModelJson,
  gatewayFromEnv,
  ModelOutputError,
  ROUTES,
  type Route,
  type GatewayConfig,
  type ModelCallResult,
} from './models.js';
export { DEFAULT_POLICY, decide, type Policy, type ActionClass, type Behavior } from './policy.js';
export { connectInProcess } from './in-process.js';
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from './fake-gateway.js';
export { MASKED, isRestrictedName } from './tools/providers.js';
export { assertRedacted } from './documents/redact.js';
export { defaultFormsDir } from './forms/templates.js';
export { storageRoot, outRoot } from './storage.js';
