import { ClientDocumentShape } from '@harness/config-api';
import type { LoadedBlueprint } from '@hf1/catalog';
import * as z from 'zod/v4';

/**
 * The document's JSON Schema, computed once and cached for every call. This belongs in
 * `@hf1/catalog` as `documentSchema()` once the catalogue's Task 3 lands it there; until then it
 * is computed here, in the one other package allowed to import `@harness/config-api` directly.
 */
let cachedSchema: object | undefined;
function documentSchema(): object {
  cachedSchema ??= z.toJSONSchema(ClientDocumentShape, { unrepresentable: 'any' });
  return cachedSchema;
}

/** The catalogue listing shape: no document, no schema. */
export function summary(b: LoadedBlueprint) {
  return {
    name: b.name,
    version: b.version,
    displayName: b.meta.displayName,
    description: b.meta.description,
    surfaces: b.meta.surfaces,
    pack: b.meta.pack,
    kernel: b.meta.kernel,
  };
}

/** The single-blueprint shape: the summary plus the document, its lock set, inputs, schema and changelog. */
export function detail(b: LoadedBlueprint) {
  return {
    ...summary(b),
    document: b.blueprint.document,
    lockset: b.blueprint.lockset,
    inputs: b.meta.inputs,
    schema: documentSchema(),
    changelog: b.changelog,
  };
}
