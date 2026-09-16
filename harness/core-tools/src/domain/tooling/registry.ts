import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { hashArgs } from './audit.js';
import { auditBaseFor } from './context.js';
import { envelope, runAuto, runBlocked, runForApproval } from './execution.js';
import { decide } from './policy.js';
import type { AnyToolDef, ToolDef, ToolDeps } from './types.js';

/**
 * Declare a tool. The only thing this does at runtime is return its argument; it exists so
 * that `I` and `O` are inferred and a handler's arguments and result are typed from the zod
 * schemas rather than annotated by hand.
 */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void {
  for (const tool of tools) deps.tools.set(tool.name, tool);
  for (const tool of tools) {
    const inputSchema = tool.input.extend({
      derived_from: z
        .array(z.string().uuid())
        .max(50)
        .optional()
        .describe('audit_log ids of earlier results these arguments were built from'),
    });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema, outputSchema: envelope(tool.output) },
      async (args: Record<string, unknown>) => {
        // `derived_from` is the registry's own argument: it is audited as lineage
        // and never reaches the handler or the arguments hash.
        const { derived_from, ...handlerArgs } = args as Record<string, unknown> & { derived_from?: string[] };
        const base = auditBaseFor(deps, tool, hashArgs(handlerArgs), derived_from ?? []);

        switch (decide(tool.actionClass, deps.policy)) {
          case 'blocked':
            return await runBlocked(deps, tool, base);
          case 'approval':
            return await runForApproval(deps, tool, base, handlerArgs);
          default:
            return await runAuto(deps, tool, base, handlerArgs);
        }
      },
    );
  }
}
