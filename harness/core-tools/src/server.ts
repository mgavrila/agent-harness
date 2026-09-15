import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { registerTools, type ToolDeps } from './registry.js';
import { loadPolicy } from './policy.js';
import { providerTools } from './tools/providers.js';
import { deadlineTools } from './tools/deadlines.js';
import { auditTools } from './tools/audit.js';
import { approvalTools } from './tools/approvals.js';

export const ALL_TOOLS = [...providerTools, ...deadlineTools, ...auditTools, ...approvalTools];

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
    sinks: {},
    context: {},
    tools: new Map(),
  };
  return { deps, close };
}

export { registerTools, defineTool, ToolError, type ToolDeps, type AnyToolDef } from './registry.js';
