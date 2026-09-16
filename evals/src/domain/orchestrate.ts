import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@harness/shared';
import type { GatewayConfig, ToolDeps } from '@harness/core-tools';
import { loadExtractionCases, loadInjectionCases, type ExtractionCase, type InjectionCase } from './cases.js';
import { FREE_TEXT_FIELDS, type JudgeItem } from './judge/types.js';
import { judgeFreeText } from './judge/verdict.js';
import { openPipeline, runCase } from './pipeline.js';
import { scoreCalibration, scoreExtraction, scoreInjection, type CalibrationRow, type CaseOutcome } from './score.js';
import { buildReport, compareToBaseline } from './report/build.js';
import { renderMarkdown } from './report/render.js';
import type { Report, SplitReport } from './report/types.js';

const log = createLogger('evals');

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
      log.warn(
        `injection row ${ic.id} names ${ic.path}, which is not an injection document in this corpus; it asserts nothing`,
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
        log.warn(`FAIL ${c.id}: ${outcome.error}`);
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

    const splitReport = (name: 'text_layer' | 'scan'): SplitReport => {
      const b = totals[name];
      const judgeCredit = agreedBySplit.get(name) ?? 0;
      return {
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
            .map(([k, v]) => [
              k,
              { total: v.total, correct: v.correct, accuracy: v.total === 0 ? 1 : v.correct / v.total },
            ]),
        ),
        calibration: scoreCalibration(b.calibration),
      };
    };
    const splits = { text_layer: splitReport('text_layer'), scan: splitReport('scan') };

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
