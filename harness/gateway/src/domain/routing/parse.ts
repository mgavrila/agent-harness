import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { RoutingFile } from './types.js';

/**
 * Parse a client's routing.yaml, or fail with the whole list of problems rather than the
 * first one. `z.prettifyError` is what turns a zod issue tree into something an operator can
 * act on; the CLI prints it verbatim.
 */
export function parseRouting(yamlText: string): RoutingFile {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = RoutingFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`routing.yaml is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
