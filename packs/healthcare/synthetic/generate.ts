import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonl } from '@harness/shared';
import { makeProvider } from './fixtures.js';
import { writeScanPdf, writeTextPdf } from './pdf.js';
import { injectionPlan, planFor } from './plan.js';
import { mulberry32 } from './rng.js';
import type { DocumentPlan, GenerateOptions, GroundTruth, GroundTruthDocument, SyntheticProvider } from './types.js';

export type {
  GenerateOptions,
  GroundTruth,
  GroundTruthCredential,
  GroundTruthDocument,
  SyntheticKind,
  SyntheticProvider,
} from './types.js';

/**
 * `generate` opens by recursively deleting its output directory, and the
 * directory comes from `--out=` on a command line. Refuse anything that is
 * neither empty nor a corpus this generator already wrote: `--out=.` would
 * otherwise wipe the repository, and `--out=~/Documents` a person's documents.
 *
 * `ground-truth.json` is the marker, because it is written last and only by
 * this function, so its presence means the directory is a finished corpus and
 * nothing else.
 */
export async function assertSafeToClear(outDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch (err) {
    // Nothing there yet is the ordinary first run.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (entries.length === 0) return;
  if (entries.includes('ground-truth.json')) return;
  throw new Error(
    `refusing to clear ${outDir}: it is not empty and does not look like a generated corpus ` +
      '(no ground-truth.json). Point --out at a new or previously generated directory.',
  );
}

export async function generate(options: GenerateOptions): Promise<GroundTruth> {
  const { outDir } = options;
  const count = options.count ?? 20;
  const seed = options.seed ?? 20260915;
  const wantScans = options.scans ?? true;
  const wantInjection = options.injection ?? true;

  const rng = mulberry32(seed);
  const providers = Array.from({ length: count }, (_, i) => makeProvider(rng, i));

  await assertSafeToClear(outDir);
  await rm(outDir, { recursive: true, force: true });
  const scratch = path.join(outDir, '.scratch');
  await mkdir(scratch, { recursive: true });

  const documents: GroundTruthDocument[] = [];

  // idPrefix distinguishes the injection twin from the provider's own document
  // of the same kind: providers[0]'s real state_license and the injection
  // state_license would otherwise both resolve to
  // `text/<slug>-state_license.pdf` and the second emit() would silently
  // clobber the first on disk (and in `documents`, on document_id collision
  // downstream). Folding idPrefix into the file name keeps every path unique.
  async function emit(provider: SyntheticProvider, plan: DocumentPlan, idPrefix: string): Promise<void> {
    const base = `${idPrefix}-${provider.slug}-${plan.kind}`;
    const textRel = path.join('text', `${base}.pdf`);
    await writeTextPdf(path.join(outDir, textRel), plan.pages);
    documents.push({
      document_id: `${idPrefix}-text_layer`,
      provider_id: provider.id,
      kind: plan.kind,
      split: 'text_layer',
      path: textRel,
      fields: plan.fields,
      credentials: plan.credentials,
      restricted: plan.restricted,
    });
    if (!wantScans) return;
    const scanRel = path.join('scan', `${base}.pdf`);
    await writeScanPdf(path.join(outDir, textRel), path.join(outDir, scanRel), scratch);
    documents.push({
      document_id: `${idPrefix}-scan`,
      provider_id: provider.id,
      kind: plan.kind,
      split: 'scan',
      path: scanRel,
      fields: plan.fields,
      credentials: plan.credentials,
      restricted: plan.restricted,
    });
  }

  for (const provider of providers) {
    for (const plan of planFor(provider)) {
      await emit(provider, plan, `${provider.id}-${plan.kind}`);
    }
  }
  if (wantInjection) {
    await emit(providers[0], injectionPlan(providers[0]), 'injection');
  }

  await rm(scratch, { recursive: true, force: true });

  const truth: GroundTruth = { seed, generated_at: new Date().toISOString(), providers, documents };
  await writeFile(path.join(outDir, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`, 'utf8');

  // One JSONL case per document, ready for @harness/evals. The case format is the runner's, not
  // this pack's: it calls the list `attachments`, because it loads a corpus from whichever pack
  // `HARNESS_PACKS` names and "credential" is one pack's word for it. The ground truth above
  // keeps the pack's own vocabulary.
  const cases = documents.map((d) => ({
    id: d.document_id,
    kind: d.kind,
    split: d.split,
    path: d.path,
    injection: d.document_id.startsWith('injection'),
    expected: { fields: d.fields, attachments: d.credentials, restricted: Object.keys(d.restricted).sort() },
  }));
  await writeJsonl(path.join(outDir, 'cases.jsonl'), cases);

  return truth;
}
