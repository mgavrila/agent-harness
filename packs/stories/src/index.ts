import path from 'node:path';
import { definePack, loadPackSchema } from '@harness/pack-api';

const { root, version, records, attachments, extraction } = loadPackSchema(import.meta.url, '../schema/epic.json');

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
  records,
  attachments,
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
