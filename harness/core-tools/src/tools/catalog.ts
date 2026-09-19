import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import { publishedCatalogue, type ToolSource } from '../domain/packs/publication.js';
import type { PackRegistry } from '../domain/packs/types.js';
import { approvalTools } from './approvals.js';
import { auditTools } from './audit.js';
import { PACK_DEADLINE_TOOLS, deadlineTools } from './deadlines.js';
import { PACK_DOCUMENT_TOOLS, documentTools } from './documents.js';
import { harnessTools } from './harness.js';
import { knowledgeTools } from './knowledge.js';
import { memoryTools } from './memory.js';
import { playbookTools } from './playbooks.js';
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
    ...knowledgeTools,
    ...memoryTools,
    ...playbookTools,
    ...documentTools(packs),
  ];
}

/**
 * What the MCP server publishes: the kernel's tools, less the ones a source replaced, less the
 * two kinds of tool nothing loaded can serve — the generic `records_*` tools when no loaded
 * record kind wants them, and `documents_classify`, `documents_extract` and `deadlines_compute`
 * when no loaded pack declares a document kind — plus every source's own. `publishedCatalogue`
 * is where those rules live and where each of them fails loudly. Less, too, the names the
 * client's own `policy.tools.hide` withholds, which is how a deployment drops one tool without
 * blinding its action class.
 */
export function publishedTools(deps: ToolDeps, kernel: AnyToolDef[] = kernelTools(deps.packs)): AnyToolDef[] {
  const sources: ToolSource[] = deps.packs.all.map((pack) => ({
    label: `pack "${pack.name}"`,
    replaces: pack.replaces ?? [],
    tools: pack.tools?.(deps) ?? [],
  }));
  // A deployment whose every kind is served by a pack's own tools publishes none of the five,
  // and its catalogue is exactly what the packs named.
  const anyGenericKind = deps.packs.recordKinds().some((r) => r.genericTools !== false);
  // The same question about the other namespace: with no document kind declared — a client with
  // no pack, since `definePack` refuses a pack that declares none — classifying and extracting
  // have no target to reach, so they are withheld rather than published and left to fail.
  //
  // `deadlines_compute` is withheld on the same condition. It schedules against the lead days a
  // record's attachment kinds declare, which only a pack supplies, so with nothing loaded it has
  // no kind to be handed either. The condition is the document one because that is what "a pack
  // is loaded" means here: `definePack` refuses a pack that declares no document kind, so a
  // registry with one is a registry with record kinds too.
  const anyDocumentKind = deps.packs.documentKinds().length > 0;
  const hidden = new Set<string>([
    ...(anyGenericKind ? [] : GENERIC_RECORD_TOOLS),
    ...(anyDocumentKind ? [] : [...PACK_DOCUMENT_TOOLS, ...PACK_DEADLINE_TOOLS]),
    // The client's own list, last, because it is the only one of the three a person wrote. It
    // unions rather than replaces: a deployment with no document kind still withholds the
    // document tools, whatever its `tools.hide` says.
    ...deps.hiddenTools,
  ]);
  return publishedCatalogue(kernel, sources, hidden);
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
  // Built once and handed to both: every call to `kernelTools` mints fresh definitions, so
  // building it twice would publish one set and leave a pack's wrapper reaching a second,
  // identical-but-separate set through `deps.kernelTools`.
  const kernel = kernelTools(deps.packs);
  for (const tool of kernel) deps.kernelTools.set(tool.name, tool);
  registerTools(server, publishedTools(deps, kernel), deps);
  return server;
}
