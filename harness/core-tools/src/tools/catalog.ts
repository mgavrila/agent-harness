import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import type { PackRegistry } from '../domain/packs/types.js';
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
 * meaningful to MCP but it is what `docs/architecture/tool-surface.json` is sorted against, so
 * adding a toolset here and forgetting to re-record the snapshot fails the suite.
 *
 * A function rather than a constant because `documents_ingest` declares the loaded packs'
 * document kinds in its input schema, and because a pack may contribute tools of its own.
 */
export function allTools(packs: PackRegistry): AnyToolDef[] {
  return [
    ...providerTools,
    ...deadlineTools,
    ...auditTools,
    ...approvalTools,
    ...harnessTools,
    ...documentTools(packs),
    ...formTools,
    ...verifyTools,
    // A pack's own tools, last, so core's names always win a collision. No pack ships any today.
    ...packs.all.flatMap((pack) => pack.tools?.(packs) ?? []),
  ];
}

/**
 * An MCP server serving every tool against one set of dependencies. It reads no environment
 * and opens no connection — `app/server.ts` builds the dependencies — which is what lets the
 * eval runner and the surface recorder construct one in-process.
 */
export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  registerTools(server, allTools(deps.packs), deps);
  return server;
}
