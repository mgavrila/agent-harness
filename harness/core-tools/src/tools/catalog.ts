import { McpServer } from '@modelcontextprotocol/server';
import type { PackToolDeps } from '@harness/pack-api';
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
 * Core's own tools, in the order they are registered. The order is not meaningful to MCP but
 * it is what `docs/architecture/tool-surface.json` is sorted against, so adding a toolset here
 * and forgetting to re-record the snapshot fails the suite.
 *
 * A function rather than a constant because `documents_ingest` declares the loaded packs'
 * document kinds in its input schema. A pack's own tools are not in this list — see
 * `createCoreToolsServer`, which is where `ToolDeps` is in scope to hand them.
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
  ];
}

/**
 * An MCP server serving every tool against one set of dependencies. It reads no environment
 * and opens no connection — `app/server.ts` builds the dependencies — which is what lets the
 * eval runner and the surface recorder construct one in-process.
 *
 * A pack's own tools are appended here, last, so core's names always win a collision, and
 * handed `deps` itself: the `Pack.tools` contract types its argument `PackToolDeps`, the
 * structural view of `ToolDeps` a pack can see without importing core-tools, and the value it
 * actually receives is core's dependency bag, the same one every core tool's handler runs
 * against. No pack ships any tools today.
 *
 * The cast is a bridge. `ToolDeps` will satisfy `PackToolDeps` structurally once it carries
 * `kernelTools` and `kernel`, which is what Plan 5 Task 3 adds along with the one `PackKernel`
 * implementation; until then the two members are missing and the compiler is right to say so.
 * Task 3 asserts the assignability and deletes both casts.
 */
export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  const tools: AnyToolDef[] = [
    ...allTools(deps.packs),
    ...deps.packs.all.flatMap(
      (pack) => (pack.tools?.(deps as unknown as PackToolDeps) ?? []) as unknown as AnyToolDef[],
    ),
  ];
  registerTools(server, tools, deps);
  return server;
}
