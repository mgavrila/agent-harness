import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayFromEnv, type GatewayConfig, type ToolDeps } from '@harness/core-tools';
import { loadExtractionCases, loadInjectionCases, type ExtractionCase } from './cases.js';
import { FREE_TEXT_FIELDS, judgeFreeText, type JudgeItem } from './judge.js';
import { openPipeline, runCase } from './pipeline.js';
import { scoreCalibration, scoreExtraction, scoreInjection, type CalibrationRow, type CaseOutcome } from './score.js';
import { buildReport, compareToBaseline, renderMarkdown, type Report, type SplitReport } from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export interface RunOptions {
  corpusDir: string;
  casesFile: string;
  injectionFile: string;
  outDir: string;
  baselineFile: string | null;
  databaseUrl: string;
  gateway: GatewayConfig;
  /** Judge deps, or null to skip the judge (no key, or an offline run). */
  judgeDeps: ToolDeps | null;
  servingModel: Record<string, string>;
  evalSetVersion: string;
  limit?: number;
}

function emptySplit(): SplitReport {
  return {
    cases: 0,
    failures: 0,
    fieldAccuracy: 1,
    credentialAccuracy: 1,
    restrictedRecall: 1,
    byKind: {},
    calibration: { pending: { total: 0, correct: 0, accuracy: 1 }, extracted: { total: 0, correct: 0, accuracy: 1 }, pendingErrorRate: 0, extractedErrorRate: 0, calibrated: false },
  };
}

/**
 * Pick at most `limit` cases. A limited run is a sample, and a sample that
 * takes the first N rows of a file grouped by provider measures one split and
 * calls it the suite. So: the injection documents first, because
 * `injection.pass_rate` is a zero-tolerance gate metric and a sample that
 * drops them reports a perfect safety score it never measured; then round
 * robin across the splits, so `text_layer` and `scan` get the same number of
 * cases and stay comparable.
 */
export function selectCases(cases: ExtractionCase[], limit?: number): ExtractionCase[] {
  if (limit === undefined || limit <= 0 || limit >= cases.length) return cases;

  const queues = new Map<string, ExtractionCase[]>();
  for (const c of cases) {
    const queue = queues.get(c.split) ?? [];
    queue.push(c);
    queues.set(c.split, queue);
  }
  // Array.sort is stable, so this lifts the injection documents to the front of
  // each split without otherwise disturbing the file's order.
  for (const queue of queues.values()) queue.sort((a, b) => Number(b.injection) - Number(a.injection));

  const splits = [...queues.keys()].sort();
  const picked: ExtractionCase[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let progressed = false;
    for (const split of splits) {
      const queue = queues.get(split) ?? [];
      if (round >= queue.length) continue;
      picked.push(queue[round]);
      progressed = true;
      if (picked.length === limit) break;
    }
    if (!progressed) break;
  }
  return picked;
}

export async function runEvals(opts: RunOptions): Promise<{ report: Report; markdown: string; exitCode: number }> {
  const cases = await loadExtractionCases(opts.casesFile);
  const injectionCases = await loadInjectionCases(opts.injectionFile);
  const selected = selectCases(cases, opts.limit);

  const pipeline = await openPipeline({ databaseUrl: opts.databaseUrl, storageDir: opts.corpusDir, gateway: opts.gateway });

  interface Bucket {
    fieldTotal: number;
    fieldCorrect: number;
    credTotal: number;
    credCorrect: number;
    restTotal: number;
    restCorrect: number;
    cases: number;
    failures: number;
    calibration: CalibrationRow[];
    /** document kind -> running field totals for the by-kind breakdown */
    byKind: Map<string, { total: number; correct: number }>;
  }
  const newBucket = (): Bucket => ({
    fieldTotal: 0,
    fieldCorrect: 0,
    credTotal: 0,
    credCorrect: 0,
    restTotal: 0,
    restCorrect: 0,
    cases: 0,
    failures: 0,
    calibration: [],
    byKind: new Map(),
  });
  const totals: Record<'text_layer' | 'scan', Bucket> = { text_layer: newBucket(), scan: newBucket() };
  const judgeItems: JudgeItem[] = [];
  const injectionFailures: string[] = [];
  let injectionPassed = 0;
  let injectionRun = 0;

  try {
    for (const c of selected) {
      await pipeline.reset();
      const outcome: CaseOutcome = await runCase(pipeline, c);
      const bucket = totals[c.split];
      bucket.cases += 1;
      if (!outcome.ok) {
        bucket.failures += 1;
        process.stderr.write(`FAIL ${c.id}: ${outcome.error}\n`);
      }

      const s = scoreExtraction(outcome, c);
      bucket.fieldTotal += s.fields.total;
      bucket.fieldCorrect += s.fields.correct;
      bucket.credTotal += s.credentials.total;
      bucket.credCorrect += s.credentials.correct;
      bucket.restTotal += s.restricted.total;
      bucket.restCorrect += s.restricted.correct;

      const kindTotals = bucket.byKind.get(c.kind) ?? { total: 0, correct: 0 };
      kindTotals.total += s.fields.total;
      kindTotals.correct += s.fields.correct;
      bucket.byKind.set(c.kind, kindTotals);

      // Calibration needs per-field right/wrong tagged with the status the
      // pipeline gave it, so pending and extracted can be compared.
      const wrongNames = new Set(s.wrong.map((w) => w.name));
      for (const field of outcome.fields) {
        if (!(field.name in c.expected.fields)) continue;
        bucket.calibration.push({ status: field.status, correct: !wrongNames.has(field.name) });
      }

      // Only free-text misses are worth a judge call; an exact match needs no
      // second opinion. The split travels with the item so the credit for an
      // agreed verdict goes back to the split the miss came from.
      for (const w of s.wrong) {
        if ((FREE_TEXT_FIELDS as readonly string[]).includes(w.name)) {
          judgeItems.push({ field: w.name, expected: w.expected, actual: w.actual, split: c.split });
        }
      }

      if (c.injection) {
        for (const ic of injectionCases) {
          injectionRun += 1;
          const verdict = scoreInjection(outcome, ic, pipeline.policy);
          if (verdict.passed) injectionPassed += 1;
          else injectionFailures.push(...verdict.failures.map((f) => `${c.id} / ${ic.id}: ${f}`));
        }
      }
    }

    // A judge that calls a miss a match turns it into a hit, so field accuracy
    // is reported after the judge has had its say. Each agreed verdict is
    // credited to its own split: pooling the credit and spreading it by field
    // count would move a text_layer win onto the scan score, and the whole
    // point of scoring the splits apart is that they are not interchangeable.
    const judge = opts.judgeDeps ? await judgeFreeText(opts.judgeDeps, judgeItems) : null;
    const agreedBySplit = new Map<string, number>();
    for (const verdict of judge?.verdicts ?? []) {
      if (verdict.same) agreedBySplit.set(verdict.split, (agreedBySplit.get(verdict.split) ?? 0) + 1);
    }

    const splits = { text_layer: emptySplit(), scan: emptySplit() };
    for (const name of ['text_layer', 'scan'] as const) {
      const b = totals[name];
      const judgeCredit = agreedBySplit.get(name) ?? 0;
      splits[name] = {
        cases: b.cases,
        failures: b.failures,
        fieldAccuracy: b.fieldTotal === 0 ? 1 : Math.min(1, (b.fieldCorrect + judgeCredit) / b.fieldTotal),
        credentialAccuracy: b.credTotal === 0 ? 1 : b.credCorrect / b.credTotal,
        restrictedRecall: b.restTotal === 0 ? 1 : b.restCorrect / b.restTotal,
        // Per-kind numbers are raw: the judge scores a field name, and the same
        // field name shows up under several document kinds, so a verdict cannot
        // be attributed to one kind honestly.
        byKind: Object.fromEntries(
          [...b.byKind.entries()]
            .sort(([a], [z]) => a.localeCompare(z))
            .map(([k, v]) => [k, { total: v.total, correct: v.correct, accuracy: v.total === 0 ? 1 : v.correct / v.total }]),
        ),
        calibration: scoreCalibration(b.calibration),
      };
    }

    const report = buildReport({
      evalSetVersion: opts.evalSetVersion,
      servingModel: opts.servingModel,
      splits,
      injection: {
        cases: injectionRun,
        passed: injectionPassed,
        passRate: injectionRun === 0 ? 1 : injectionPassed / injectionRun,
        failures: injectionFailures,
      },
      judge: judge ? { scored: judge.scored, agreementRate: judge.agreementRate } : null,
      metricOverrides: {},
    });

    let baseline: Report | null = null;
    if (opts.baselineFile) {
      try {
        baseline = JSON.parse(await readFile(opts.baselineFile, 'utf8')) as Report;
      } catch {
        baseline = null;
      }
    }
    const comparison = baseline ? compareToBaseline(report, baseline) : null;
    const markdown = renderMarkdown(report, comparison);

    await mkdir(opts.outDir, { recursive: true });
    await writeFile(path.join(opts.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(opts.outDir, 'report.md'), markdown, 'utf8');

    // CI contract: non-zero on a regression, or on a failed injection case,
    // whether or not a baseline exists. "No baseline yet" is not a pass.
    const regressed = comparison !== null && comparison.regressions.length > 0;
    const leaked = report.injection.passed < report.injection.cases;
    return { report, markdown, exitCode: regressed || leaked ? 1 : 0 };
  } finally {
    await pipeline.close();
  }
}

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CLI only, like `@harness/db`'s migrate: a test that imports `runEvals` must
  // not pick up the developer's repository-root .env.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

  const corpusDir = path.resolve(flag('corpus') ?? path.join(repoRoot, 'packs/healthcare/synthetic/out'));
  const gateway = gatewayFromEnv();
  const routing = JSON.parse(process.env.EVALS_SERVING_MODEL ?? '{}') as Record<string, string>;

  const { report, markdown, exitCode } = await runEvals({
    corpusDir,
    casesFile: flag('cases') ?? path.join(corpusDir, 'cases.jsonl'),
    injectionFile: flag('injection') ?? path.join(repoRoot, 'packs/healthcare/evals/injection.jsonl'),
    outDir: path.resolve(flag('out') ?? path.join(repoRoot, 'evals/results')),
    baselineFile: flag('baseline') ?? path.join(repoRoot, 'evals/baseline.json'),
    databaseUrl: process.env.EVALS_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_evals',
    gateway,
    judgeDeps: null,
    servingModel: Object.keys(routing).length > 0 ? routing : { extract: 'see clients/<name>/routing.yaml', judge: 'see clients/<name>/routing.yaml' },
    evalSetVersion: flag('version') ?? '1.0.0',
    limit: flag('limit') ? Number(flag('limit')) : undefined,
  });

  process.stdout.write(`${markdown}\n`);
  if (flag('update-baseline') === 'true') {
    await writeFile(path.join(repoRoot, 'evals/baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write('baseline updated\n');
  }
  process.exit(exitCode);
}
