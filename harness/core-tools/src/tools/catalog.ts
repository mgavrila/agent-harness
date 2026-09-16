import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import { publishedCatalogue, type ToolSource } from '../domain/packs/publication.js';
import type { PackRegistry } from '../domain/packs/types.js';
import { approvalTools } from './approvals.js';
import { auditTools } from './audit.js';
import { deadlineTools } from './deadlines.js';
import { documentTools } from './documents.js';
import { harnessTools } from './harness.js';
import { GENERIC_RECORD_TOOLS, recordTools } from './records.js';

/**
 * Every tool the kernel itself defines, whatever any pack replaces.
 *
 * This is what fills `deps.kernelTools`, so a pack's wrapper can reach the handler behind the
 * name it took over. It is not what is published — see `publishedTools`.
 */
export function kernelTools(packs: PackRegistry): AnyToolDef[] {
  return [
    ...recordTools(packs),
    ...deadlineTools,
    ...auditTools,
    ...approvalTools,
    ...harnessTools,
    ...documentTools(packs),
  ];
}

/**
 * Kept for `src/index.ts`, which re-exports it.
 *
 * It is **not** what a skill's declared tools are checked against any more: that has to be the
 * published catalogue, because from this task onwards the kernel list and the published list
 * differ. `tools/skills-frontmatter.test.ts` uses `publishedTools`.
 */
export const allTools = kernelTools;

/**
 * What the MCP server publishes: the kernel's tools, less the ones a source replaced and the
 * generic `records_*` tools when no loaded record kind wants them, plus every source's own.
 * `publishedCatalogue` is where those rules live and where each of them fails loudly.
 */
export function publishedTools(deps: ToolDeps): AnyToolDef[] {
  const sources: ToolSource[] = deps.packs.all.map((pack) => ({
    label: `pack "${pack.name}"`,
    replaces: pack.replaces ?? [],
    tools: pack.tools?.(deps) ?? [],
  }));
  // A deployment whose every kind is served by a pack's own tools publishes none of the five,
  // and its catalogue is exactly what the packs named.
  const anyGenericKind = deps.packs.recordKinds().some((r) => r.genericTools !== false);
  const hidden = anyGenericKind ? new Set<string>() : new Set<string>(GENERIC_RECORD_TOOLS);
  return publishedCatalogue(kernelTools(deps.packs), sources, hidden);
}

/**
 * An MCP server serving every published tool against one set of dependencies. It reads no
 * environment and opens no connection — `app/server.ts` builds the dependencies — which is what
 * lets the eval runner and the surface recorder construct one in-process.
 *
 * `deps.kernelTools` is filled first and with every kernel tool, replaced or not, because a
 * pack's wrapper reaches the handler it wraps through it. `deps.tools`, which `registerTools`
 * fills, stays what it always was: the published catalogue, which `approvals_execute` replays a
 * parked action from — pack tools included, since `forms_release` is `external`.
 */
export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  for (const tool of kernelTools(deps.packs)) deps.kernelTools.set(tool.name, tool);
  registerTools(server, publishedTools(deps), deps);
  return server;
}
