import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayFromEnv, type GatewayConfig, type ToolDeps } from '@harness/core-tools';
import { loadExtractionCases, loadInjectionCases, type ExtractionCase, type InjectionCase } from './cases.js';
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
  /** Threshold the pipeline applies and the scorers assert on. Defaults to the shipped one. */
  confidenceThreshold?: number;
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

/**
 * Which injection rows are asserted against this document. A row's `path`
 * names the document its assertions were written for, so it is scored against
 * that document alone. Scoring every row against every injection-flagged case
 * checked one row's `must_not_appear` phrases against another row's document,
 * where a phrase that was never printed passes for free and the attack the
 * row describes goes unmeasured.
 *
 * A row with no `path` is a general assertion about any injected document and
 * still applies to all of them.
 */
export function injectionCasesFor(c: ExtractionCase, injectionCases: InjectionCase[]): InjectionCase[] {
  return injectionCases.filter((ic) => ic.path === undefined || ic.path === c.path);
}

/**
 * A row whose `path` names no document in the corpus asserts nothing. The
 * corpus is regenerated per seed, so a committed path can go stale silently
 * and quietly switch off part of a zero-tolerance gate; say so rather than
 * reporting a smaller `injection.cases` and moving on. Checked against the
 * whole corpus, not the selected subset, so `--limit` does not warn.
 */
function warnOnUnmatchedInjectionRows(cases: ExtractionCase[], injectionCases: InjectionCase[]): void {
  const known = new Set(cases.filter((c) => c.injection).map((c) => c.path));
  for (const ic of injectionCases) {
    if (ic.path !== undefined && !known.has(ic.path)) {
      process.stderr.write(
        `WARNING injection row ${ic.id} names ${ic.path}, which is not an injection document in this corpus; it asserts nothing\n`,
      );
    }
  }
}

export async function runEvals(opts: RunOptions): Promise<{ report: Report; markdown: string; exitCode: number }> {
  const cases = await loadExtractionCases(opts.casesFile);
  const injectionCases = await loadInjectionCases(opts.injectionFile);
  warnOnUnmatchedInjectionRows(cases, injectionCases);
  const selected = selectCases(cases, opts.limit);

  const pipeline = await openPipeline({
    databaseUrl: opts.databaseUrl,
    storageDir: opts.corpusDir,
    gateway: opts.gateway,
    confidenceThreshold: opts.confidenceThreshold,
  });

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
        for (const ic of injectionCasesFor(c, injectionCases)) {
          injectionRun += 1;
          const verdict = scoreInjection(outcome, ic, pipeline.policy, pipeline.confidenceThreshold);
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
    // `null` here means the judge did not run at all — no deps, or the route
    // was down. It is not an agreement rate of 1, and `buildReport` keeps it out
    // of the metric map rather than inventing one.
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

    // CI contract: non-zero on a regression, on a metric the baseline measured
    // that this run did not, or on a failed injection case, whether or not a
    // baseline exists. "No baseline yet" is not a pass. This is deliberately
    // NOT keyed off `passesPromotionGate`: a neutral run (no regression, no
    // improvement either) is a legitimate exit 0, not a failure.
    const regressed = comparison !== null && comparison.regressions.length > 0;
    const stoppedMeasuring = comparison !== null && comparison.stoppedMeasuring.length > 0;
    const leaked = report.injection.passed < report.injection.cases;
    return { report, markdown, exitCode: regressed || stoppedMeasuring || leaked ? 1 : 0 };
  } finally {
    await pipeline.close();
  }
}

function flagFrom(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function flag(name: string): string | undefined {
  return flagFrom(process.argv, name);
}

export type LimitFlagResult = { ok: true; limit: number | undefined } | { ok: false; error: string };

/**
 * `--limit=N` must be a positive integer. `Number(flag)` alone lets `NaN`
 * (from an empty, non-numeric, or missing value) through as a defined
 * `RunOptions.limit`, and `selectCases` treats a `NaN` limit as "keep
 * shrinking the picked list forever" only by accident of `picked.length <
 * limit` being false for a `NaN` bound in one direction and true in the
 * other — in practice it silently selects zero cases, so the run scores
 * nothing and still exits 0. A bad `--limit` must fail loudly instead.
 *
 * Pure and exported so a test can check every input without spawning the CLI;
 * the CLI entry point below turns `{ ok: false }` into `exit 2`.
 */
export function parseLimitFlag(argv: readonly string[]): LimitFlagResult {
  const raw = flagFrom(argv, 'limit');
  if (raw === undefined) return { ok: true, limit: undefined };
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { ok: false, error: `--limit must be a positive integer, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, limit: Number(raw) };
}

export type UpdateBaselineFlagResult = { ok: true; update: boolean } | { ok: false; error: string };

/**
 * `--update-baseline` and `--update-baseline=true` both mean "write the
 * report as the new baseline"; `--update-baseline=false` means "do not".
 * Any other value is a usage error rather than a silent no-op, because a
 * typo here would quietly leave the old baseline in place.
 */
export function parseUpdateBaselineFlag(argv: readonly string[]): UpdateBaselineFlagResult {
  if (argv.includes('--update-baseline')) return { ok: true, update: true };
  const raw = flagFrom(argv, 'update-baseline');
  if (raw === undefined || raw === 'false') return { ok: true, update: false };
  if (raw === 'true') return { ok: true, update: true };
  return { ok: false, error: `--update-baseline takes no value, true or false, got ${JSON.stringify(raw)}` };
}

/**
 * CLI usage: `pnpm --filter @harness/evals start -- [flags]`
 *
 *   --corpus=<dir>      Corpus root. Defaults to packs/healthcare/synthetic/out.
 *   --cases=<file>      Extraction cases file. Defaults to <corpus>/cases.jsonl.
 *   --injection=<file>  Injection cases file. Defaults to packs/healthcare/evals/injection.jsonl.
 *   --out=<dir>         Where report.json and report.md are written. Defaults to evals/results.
 *   --baseline=<file>   Baseline report to compare against. Defaults to evals/baseline.json.
 *   --version=<string>  Recorded as eval_set_version. Defaults to 1.0.0.
 *   --limit=<N>         Positive integer. Run a sample of N cases instead of the whole corpus
 *                        (see selectCases). Anything else is a usage error: exit 2, nothing run.
 *   --gateway=<url>     Override the gateway's base URL only. The key still comes from
 *                        LITELLM_MASTER_KEY via gatewayFromEnv() -- this never takes a key on
 *                        the command line.
 *   --update-baseline   After scoring, write the report to the --baseline path (default
 *                        evals/baseline.json). `=true` is accepted too; `=false` is a no-op.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Validate CLI-only flags before anything that touches the environment or a
  // network, so a usage error exits 2 with no cases run and no gateway or
  // database required, rather than failing later for an unrelated reason.
  const limitFlag = parseLimitFlag(process.argv);
  if (!limitFlag.ok) {
    process.stderr.write(`${limitFlag.error}\n`);
    process.exit(2);
  }
  const updateBaselineFlag = parseUpdateBaselineFlag(process.argv);
  if (!updateBaselineFlag.ok) {
    process.stderr.write(`${updateBaselineFlag.error}\n`);
    process.exit(2);
  }

  // CLI only, like `@harness/db`'s migrate: a test that imports `runEvals` must
  // not pick up the developer's repository-root .env.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

  const corpusDir = path.resolve(flag('corpus') ?? path.join(repoRoot, 'packs/healthcare/synthetic/out'));
  const gateway = gatewayFromEnv();
  // `--gateway` overrides only the proxy's base URL, for pointing a run at a
  // gateway other than `HARNESS_GATEWAY_URL` (a staging proxy, a fake one in
  // an ad hoc smoke test). The key still comes from the environment: a
  // gateway address is not a secret and belongs on the command line, but
  // `LITELLM_MASTER_KEY` does not.
  const gatewayOverride = flag('gateway');
  if (gatewayOverride) gateway.baseUrl = gatewayOverride.replace(/\/+$/, '');
  const routing = JSON.parse(process.env.EVALS_SERVING_MODEL ?? '{}') as Record<string, string>;
  const limit = limitFlag.limit;
  const baselineFile = path.resolve(flag('baseline') ?? path.join(repoRoot, 'evals/baseline.json'));

  const { report, markdown, exitCode } = await runEvals({
    corpusDir,
    casesFile: flag('cases') ?? path.join(corpusDir, 'cases.jsonl'),
    injectionFile: flag('injection') ?? path.join(repoRoot, 'packs/healthcare/evals/injection.jsonl'),
    outDir: path.resolve(flag('out') ?? path.join(repoRoot, 'evals/results')),
    baselineFile,
    databaseUrl: process.env.EVALS_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_evals',
    gateway,
    judgeDeps: null,
    servingModel: Object.keys(routing).length > 0 ? routing : { extract: 'see clients/<name>/routing.yaml', judge: 'see clients/<name>/routing.yaml' },
    evalSetVersion: flag('version') ?? '1.0.0',
    limit,
  });

  process.stdout.write(`${markdown}\n`);
  if (updateBaselineFlag.update) {
    await writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write('baseline updated\n');
  }
  process.exit(exitCode);
}
