import { ConfigError } from '@harness/shared';
import type { AnyToolDef } from '../tooling/types.js';

/**
 * One contributor of tools to the published catalogue: a loaded pack, or the transitional
 * compat layer that stands in for one until Plan 5 Task 4 moves it into the healthcare pack.
 */
export interface ToolSource {
  /** Names the source in every failure message an operator reads. */
  label: string;
  /** Kernel tool names this source's own tools supersede. */
  replaces: readonly string[];
  tools: AnyToolDef[];
}

/**
 * Resolve the kernel's tools and every source's into the one list the MCP server publishes.
 *
 * Three rules, in this order, and each one fails loudly rather than quietly:
 *
 *  1. A kernel tool in `hidden` is not published. That set is how the generic `records_*` tools
 *     stay out of a catalogue whose every record kind is served by a pack's own tools.
 *  2. A kernel tool named in a source's `replaces` is dropped. A name that is not a kernel tool
 *     is a `ConfigError`, not a no-op: a typo there would leave the generic tool published
 *     beside a half-working replacement and nothing would say so.
 *  3. Two sources may not publish the same name, and two sources may not replace the same name.
 *     Either is a `ConfigError` naming both.
 *
 * It lives in the domain rather than in `tools/catalog.ts` because every failure here is a
 * startup misconfiguration an operator reads, not a tool result an agent reads — which is the
 * same reason `tools/` may not throw anything but a `ToolError`.
 */
export function publishedCatalogue(
  kernel: AnyToolDef[],
  sources: ToolSource[],
  hidden: ReadonlySet<string>,
): AnyToolDef[] {
  const kernelNames = new Set(kernel.map((t) => t.name));

  const replacedBy = new Map<string, string>();
  for (const source of sources) {
    for (const name of source.replaces) {
      if (!kernelNames.has(name)) {
        throw new ConfigError(`${source.label} replaces "${name}", which is not a kernel tool`);
      }
      const already = replacedBy.get(name);
      if (already) throw new ConfigError(`${source.label} and ${already} both replace "${name}"`);
      replacedBy.set(name, source.label);
    }
  }

  const published: AnyToolDef[] = kernel.filter((t) => !replacedBy.has(t.name) && !hidden.has(t.name));

  const from = new Map<string, string>(published.map((t) => [t.name, 'the kernel']));
  for (const source of sources) {
    for (const tool of source.tools) {
      const already = from.get(tool.name);
      if (already) throw new ConfigError(`${source.label} and ${already} both publish "${tool.name}"`);
      from.set(tool.name, source.label);
      published.push(tool);
    }
  }
  return published;
}
