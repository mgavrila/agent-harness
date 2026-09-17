import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  definePack,
  parseExtractionManifest,
  type ExtractionManifest,
  type RawAttachmentKind,
  type RawRecordKind,
} from '@harness/pack-api';

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
const raw = requireJson('../schema/epic.json') as RawManifest;
const { version } = requireJson('../package.json') as { version: string };

const extraction = parseExtractionManifest(raw.extraction);

/**
 * Document scanning that produces epics.
 *
 * The proof pack. It exists so that a kernel which still assumes credentialing fails the build:
 * it declares one record kind whose fields have nothing to do with a provider, one attachment
 * kind that never expires, no forms directory, no tools of its own and no replaced kernel tool.
 * Everything its skill does, it does through `documents_*` and `records_*`.
 *
 * `policy` is empty: it introduces no action class of its own, so `DEFAULT_POLICY` and the
 * client's `policy.yaml` decide, exactly as they do for every other pack.
 */
export const pack = definePack({
  name: 'stories',
  version,
  records: raw.records,
  attachments: raw.attachments,
  documentKinds: extraction.document_kinds,
  extraction,
  skillsDir: path.join(root, 'skills'),
  policy: {},
  evals: {
    casesFile: path.join(root, 'evals', 'cases.jsonl'),
    injectionFile: path.join(root, 'evals', 'injection.jsonl'),
    corpusDir: path.join(root, 'synthetic', 'out'),
    intakeSkill: path.join(root, 'skills', 'stories-intake', 'SKILL.md'),
    judgedFields: ['summary'],
    generate: '@harness/pack-stories/generate',
  },
});
