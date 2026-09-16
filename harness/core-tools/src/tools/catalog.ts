import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import { approvalTools } from './approvals.js';
import { auditTools } from './audit.js';
import { deadlineTools } from './deadlines.js';
import { documentTools } from './documents.js';
import { formTools } from './forms.js';
import { harnessTools } from './harness.js';
import { providerTools } from './providers.js';
import { verifyTools } from './verify.js';

/**
 * Every tool this server publishes, in the order they are registered. The order is not
 * meaningful to MCP but it is what `docs/architecture/tool-surface.json` is sorted against,
 * so adding a toolset here and forgetting to re-record the snapshot fails the suite.
 */
export const ALL_TOOLS: AnyToolDef[] = [
  ...providerTools,
  ...deadlineTools,
  ...auditTools,
  ...approvalTools,
  ...harnessTools,
  ...documentTools,
  ...formTools,
  ...verifyTools,
];

/**
 * An MCP server serving every tool against one set of dependencies. It reads no environment
 * and opens no connection — `app/server.ts` builds the dependencies — which is what lets the
 * eval runner and the surface recorder construct one in-process.
 */
export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  registerTools(server, ALL_TOOLS, deps);
  return server;
}
