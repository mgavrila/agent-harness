import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { definePack, type Policy, type ProviderManifest } from '@harness/pack-api';

/** The pack root: one level up from `src/`. Every path below is absolute, as the contract requires. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A JSON import would need an import attribute and a resolver flag; a require
// keeps both files loadable from tsx, vitest and a built bundle alike.
const requireJson = createRequire(import.meta.url);

const extraction = requireJson('../schema/provider.json') as ProviderManifest;
const { version } = requireJson('../package.json') as { version: string };

/**
 * The action-class defaults this pack ships, read from the file a human edits. The `Pack`
 * contract carries this field, but core's `loadPolicy` does not merge it into `deps.policy`
 * yet — see ARCHITECTURE.md, "Packs are plug-ins, not dependencies". That is unobservable
 * today because this file matches `DEFAULT_POLICY`; it stops being unobservable the day a
 * pack's classes and `DEFAULT_POLICY` diverge.
 */
const { classes = {} } = parseYaml(readFileSync(path.join(root, 'policy.yaml'), 'utf8')) as {
  classes?: Partial<Policy>;
};

/**
 * Healthcare credentialing.
 *
 * `extraction` is the manifest core validates on load — the shape check happens there, against
 * core's own restricted-name rules, because those are the rules that decide what gets
 * encrypted. `documentKinds` is taken from the manifest rather than written twice: the list a
 * model may classify into and the list the manifest declares are the same list, and two copies
 * would drift.
 */
export const pack = definePack({
  name: 'healthcare',
  version,
  documentKinds: extraction.document_kinds,
  extraction,
  formsDir: path.join(root, 'forms'),
  skillsDir: path.join(root, 'skills'),
  policy: classes,
  evals: { injectionFile: path.join(root, 'evals', 'injection.jsonl') },
});
