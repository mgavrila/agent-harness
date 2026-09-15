import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { registerTools, type ToolDeps } from './registry.js';
import { loadPolicy } from './policy.js';
import { gatewayFromEnv } from './models.js';
import { providerTools } from './tools/providers.js';
import { deadlineTools } from './tools/deadlines.js';
import { auditTools } from './tools/audit.js';
import { approvalTools } from './tools/approvals.js';
import { harnessTools } from './tools/harness.js';

export const ALL_TOOLS = [...providerTools, ...deadlineTools, ...auditTools, ...approvalTools, ...harnessTools];

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
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', 0.85, { min: 0, max: 1 }),
    gateway: gatewayFromEnv(),
    storageDir: path.resolve(process.env.HARNESS_STORAGE_DIR ?? './storage'),
    restrictedToModel: process.env.HARNESS_RESTRICTED_TO_MODEL === 'true',
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

export { registerTools, defineTool, ToolError, type ToolDeps, type AnyToolDef } from './registry.js';
export { callModel, callModelJson, gatewayFromEnv, ROUTES, type Route, type GatewayConfig, type ModelCallResult } from './models.js';
