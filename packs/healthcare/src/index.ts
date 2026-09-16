import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  definePack,
  parseExtractionManifest,
  type ExtractionManifest,
  type Policy,
  type RawAttachmentKind,
  type RawRecordKind,
} from '@harness/pack-api';
import { HEALTHCARE_REPLACES, healthcareTools } from './tools/index.js';

/** The pack root: one level up from `src/`. Every path below is absolute, as the contract requires. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A JSON import would need an import attribute and a resolver flag; a require keeps both files
// loadable from tsx, vitest and a built bundle alike.
const requireJson = createRequire(import.meta.url);

interface RawManifest {
  records: RawRecordKind[];
  attachments: RawAttachmentKind[];
  extraction: ExtractionManifest;
}
const raw = requireJson('../schema/provider.json') as RawManifest;
const { version } = requireJson('../package.json') as { version: string };

const extraction = parseExtractionManifest(raw.extraction);

/**
 * The action-class defaults this pack ships, read from the file a human edits. The `Pack`
 * contract carries this field, but core's `loadPolicy` does not merge it into `deps.policy`
 * yet — see ARCHITECTURE.md, "Packs are plug-ins, not dependencies".
 */
const { classes = {} } = parseYaml(readFileSync(path.join(root, 'policy.yaml'), 'utf8')) as {
  classes?: Partial<Policy>;
};

/**
 * Healthcare credentialing.
 *
 * The record kinds are handed over as declared and the kernel parses them on load, against its
 * own restricted-name rules: those rules decide what gets encrypted, so they belong to whoever
 * does the encrypting. `documentKinds` comes off the extraction manifest rather than being
 * written twice.
 */
export const pack = definePack({
  name: 'healthcare',
  version,
  records: raw.records,
  attachments: raw.attachments,
  documentKinds: extraction.document_kinds,
  extraction,
  formsDir: path.join(root, 'forms'),
  skillsDir: path.join(root, 'skills'),
  policy: classes,
  evals: {
    casesFile: path.join(root, 'synthetic', 'out', 'cases.jsonl'),
    injectionFile: path.join(root, 'evals', 'injection.jsonl'),
    corpusDir: path.join(root, 'synthetic', 'out'),
    intakeSkill: path.join(root, 'skills', 'credentialing-intake', 'SKILL.md'),
    judgedFields: [
      'practice_name',
      'practice_address',
      'specialty',
      'medical_school',
      'malpractice_carrier',
      'malpractice_coverage',
    ],
    generate: '@harness/pack-healthcare/generate',
    readback: { tool: 'providers_get', recordIdKey: 'provider_id', attachmentsKey: 'credentials' },
  },
  replaces: HEALTHCARE_REPLACES,
  tools: healthcareTools,
});

/**
 * Two pieces of this pack's content that core-tools' own tests read.
 *
 * They are here rather than reached by a path into `src/`, which `pnpm arch` forbids across
 * packages. `ROSTER_COLUMNS` is the payer's column contract, asserted against `forms_roster`'s
 * result; `loadManifest` is how the kernel-side test checks that no template this pack ships
 * maps a name the kernel's own redaction rules call restricted — a check that needs both
 * halves and so cannot live in either alone.
 */
export { loadManifest } from './domain/forms/templates.js';
export { ROSTER_COLUMNS } from './domain/forms/types.js';
