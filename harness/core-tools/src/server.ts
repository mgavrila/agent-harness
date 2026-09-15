import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { registerTools, type ToolDeps } from './registry.js';
import { loadPolicy } from './policy.js';
import { providerTools } from './tools/providers.js';
import { deadlineTools } from './tools/deadlines.js';
import { auditTools } from './tools/audit.js';

export const ALL_TOOLS = [...providerTools, ...deadlineTools, ...auditTools];

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
    approvalTtlHours: Number(process.env.APPROVAL_TTL_HOURS ?? 24),
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.85),
  };
  return { deps, close };
}

export { registerTools, defineTool, ToolError, type ToolDeps, type AnyToolDef } from './registry.js';
