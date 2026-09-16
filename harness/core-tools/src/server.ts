import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { booleanFromEnv, numberFromEnv } from '@harness/shared';
import { registerTools } from './domain/tooling/registry.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from './domain/tooling/types.js';
import { loadPolicy } from './domain/tooling/policy.js';
import { gatewayFromEnv } from './domain/models/gateway.js';
import { storageRoot } from './domain/storage/layout.js';
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
    // storageRoot). Ingested documents live under it as domain/storage/
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
  ToolError,
  ModelOutputError,
  ConfigError,
  describeError,
  numberFromEnv,
  booleanFromEnv,
  requiredEnv,
  optionalEnv,
  createLogger,
  realOrNearestAncestor,
  assertInsideRoot,
  runBounded,
  readJsonl,
  writeJsonl,
  csvCell,
  type NumberEnvOptions,
  type Logger,
  type EscapeReason,
  type InsideRootOptions,
  type RunBoundedOptions,
  type RunBoundedOutcome,
  type JsonlRow,
} from '@harness/shared';
export { containsRestrictedPattern, isValidDea, type RestrictedKind } from './shared/redaction/patterns.js';
export { isRestrictedName, MASKED } from './shared/redaction/names.js';
export {
  redactPages,
  assertRedacted,
  fieldNameFor,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './shared/redaction/text.js';
export { registerTools, defineTool } from './domain/tooling/registry.js';
export { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps, type AnyToolDef } from './domain/tooling/types.js';
export { callModel, callModelJson, gatewayFromEnv } from './domain/models/gateway.js';
export { ROUTES, type Route, type GatewayConfig, type ModelCallResult } from './domain/models/types.js';
export { DEFAULT_POLICY, decide, type Policy, type ActionClass, type Behavior } from './domain/tooling/policy.js';
export { connectInProcess } from './domain/tooling/in-process.js';
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from './domain/models/fake.js';
export { defaultFormsDir } from './forms/templates.js';
export { storageRoot, outRoot } from './domain/storage/layout.js';
