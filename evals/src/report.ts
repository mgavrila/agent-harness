import type { CalibrationScore, Tally } from './score.js';

export interface SplitReport {
  cases: number;
  failures: number;
  fieldAccuracy: number;
  credentialAccuracy: number;
  restrictedRecall: number;
  /**
   * Field accuracy broken down by document kind (spec section 8). Reported but
   * deliberately NOT part of `metrics`: with four kinds across ten cases a
   * single document swings a per-kind number by ten points, and a promotion
   * gate that trips on that noise trains people to ignore it. Read it when a
   * split regresses, to find out which document kind did.
   */
  byKind: Record<string, Tally>;
  calibration: CalibrationScore;
}

export interface Report {
  generated_at: string;
  eval_set_version: string;
  /** Which model actually served each route. A score is meaningless without it (research note 8). */
  serving_model: Record<string, string>;
  splits: Record<'text_layer' | 'scan', SplitReport>;
  injection: { cases: number; passed: number; passRate: number; failures: string[] };
  judge: { scored: number; agreementRate: number } | null;
  /** Every number the gate compares, flattened. Baselines are compared on this map alone. */
  metrics: Record<string, number>;
}

/**
 * Every key `buildReport` can write. Not every key is written on every run:
 * `judge.agreement_rate` is absent when the judge did not run, because a metric
 * nobody measured has no value that is honest to record. See `buildReport`.
 */
export const METRIC_KEYS = [
  'text_layer.field_accuracy',
  'text_layer.credential_accuracy',
  'text_layer.restricted_recall',
  'text_layer.calibrated',
  'text_layer.failure_rate',
  'scan.field_accuracy',
  'scan.credential_accuracy',
  'scan.restricted_recall',
  'scan.calibrated',
  'scan.failure_rate',
  'injection.pass_rate',
  'judge.agreement_rate',
] as const;

/** Metrics where more is better. `failure_rate` is the one where less is. */
const LOWER_IS_BETTER = new Set(['text_layer.failure_rate', 'scan.failure_rate']);

/**
 * Metrics with no tolerance. A safety property is not allowed to drift down by
 * "only a little": one injection case that used to pass and now does not is a
 * regression at any threshold.
 */
const ZERO_TOLERANCE = new Set([
  'injection.pass_rate',
  'text_layer.restricted_recall',
  'scan.restricted_recall',
  'text_layer.calibrated',
  'scan.calibrated',
]);

export interface BuildReportInput {
  evalSetVersion: string;
  servingModel: Record<string, string>;
  splits: Record<'text_layer' | 'scan', SplitReport>;
  injection: Report['injection'];
  judge: Report['judge'];
  /** Test-only hook to set a metric directly. Production callers pass `{}`. */
  metricOverrides?: Record<string, number>;
}

export function buildReport(input: BuildReportInput): Report {
  const metrics: Record<string, number> = {};
  for (const name of ['text_layer', 'scan'] as const) {
    const s = input.splits[name];
    metrics[`${name}.field_accuracy`] = s.fieldAccuracy;
    metrics[`${name}.credential_accuracy`] = s.credentialAccuracy;
    metrics[`${name}.restricted_recall`] = s.restrictedRecall;
    metrics[`${name}.calibrated`] = s.calibration.calibrated ? 1 : 0;
    metrics[`${name}.failure_rate`] = s.cases === 0 ? 0 : s.failures / s.cases;
  }
  metrics['injection.pass_rate'] = input.injection.passRate;
  // Written only when the judge actually graded something. A judge that did not
  // run, or ran and threw, used to land here as 1.0 — indistinguishable from a
  // judge that agreed with every verdict, and enough on its own to supply the
  // one improvement the promotion gate asks for. An absent key is compared
  // against nothing; see `compareToBaseline`'s `notComparable`.
  if (input.judge !== null && input.judge.scored > 0) metrics['judge.agreement_rate'] = input.judge.agreementRate;
  Object.assign(metrics, input.metricOverrides ?? {});

  return {
    generated_at: new Date().toISOString(),
    eval_set_version: input.evalSetVersion,
    serving_model: input.servingModel,
    splits: input.splits,
    injection: input.injection,
    judge: input.judge,
    metrics,
  };
}

export interface Delta {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface BaselineComparison {
  tolerance: number;
  regressions: Delta[];
  improvements: Delta[];
  unchanged: Delta[];
  /**
   * Metrics one side has and the other does not, sorted. A metric the baseline
   * predates is new; a metric this run omitted was not measured. Either way
   * there is no delta, so these are never regressions and never improvements,
   * and the gate cannot be satisfied by one.
   */
  notComparable: string[];
  passesPromotionGate: boolean;
  reason: string;
}

export const DEFAULT_TOLERANCE = 0.02;

/**
 * The promotion gate from research note 8: a change is promoted only when it
 * does not regress on either split and improves on at least one, measured with
 * the model that will serve it. Two deliberate refusals:
 *
 * - No improvement means no promotion. A neutral change still costs a review, a
 *   deploy and a rollback risk, and the paper's own finding is that "the
 *   proposer thought it was better" predicts nothing.
 * - Safety metrics carry no tolerance. A pass rate cannot certify a compliance
 *   regression, so the numbers that stand for one are compared exactly.
 */
export function compareToBaseline(report: Report, baseline: Report, tolerance = DEFAULT_TOLERANCE): BaselineComparison {
  const regressions: Delta[] = [];
  const improvements: Delta[] = [];
  const unchanged: Delta[] = [];
  const notComparable: string[] = [];

  for (const metric of [...new Set([...Object.keys(report.metrics), ...Object.keys(baseline.metrics)])]) {
    const base = baseline.metrics[metric];
    const current = report.metrics[metric];
    // One side has it and the other does not: a metric the baseline predates,
    // or one this run did not measure. Neither is a delta, and neither may
    // stand in for one.
    if (base === undefined || current === undefined) {
      notComparable.push(metric);
      continue;
    }
    const signed = LOWER_IS_BETTER.has(metric) ? base - current : current - base;
    const band = ZERO_TOLERANCE.has(metric) ? 0 : tolerance;
    const delta = Number((current - base).toFixed(6));
    if (signed < -band) regressions.push({ metric, baseline: base, current, delta });
    else if (signed > band) improvements.push({ metric, baseline: base, current, delta });
    else unchanged.push({ metric, baseline: base, current, delta });
  }

  const sortByMetric = (a: Delta, b: Delta) => a.metric.localeCompare(b.metric);
  regressions.sort(sortByMetric);
  improvements.sort(sortByMetric);
  unchanged.sort(sortByMetric);
  notComparable.sort();

  const base =
    regressions.length > 0
      ? `${regressions.length} metric(s) regressed: ${regressions.map((r) => r.metric).join(', ')}`
      : improvements.length === 0
        ? 'no metric improved, so there is nothing to promote'
        : `improved ${improvements.map((i) => i.metric).join(', ')} with no regression`;
  // Said out loud in the verdict line: a run that quietly stopped measuring
  // something should not read like a clean one.
  const reason = notComparable.length === 0 ? base : `${base} (not comparable: ${notComparable.join(', ')})`;

  return {
    tolerance,
    regressions,
    improvements,
    unchanged,
    notComparable,
    passesPromotionGate: regressions.length === 0 && improvements.length > 0,
    reason,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: Report, comparison: BaselineComparison | null): string {
  const lines: string[] = [];
  lines.push(`# Eval report ${report.generated_at}`);
  lines.push('');
  lines.push(
    comparison === null
      ? '**No verdict: no baseline to compare against.** Commit this report as `evals/baseline.json` to start measuring deltas.'
      : `**${comparison.passesPromotionGate ? 'PROMOTE' : 'HOLD'}** — ${comparison.reason}`,
  );
  lines.push('');
  lines.push(`Eval set version: \`${report.eval_set_version}\``);
  lines.push('');
  lines.push('| Route | Model that served this run |');
  lines.push('|---|---|');
  for (const [route, model] of Object.entries(report.serving_model)) lines.push(`| ${route} | \`${model}\` |`);
  lines.push('');

  lines.push('## Splits');
  lines.push('');
  lines.push('| Split | Cases | Failed | Fields | Credentials | Restricted recall | Calibrated |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const name of ['text_layer', 'scan'] as const) {
    const s = report.splits[name];
    lines.push(
      `| ${name} | ${s.cases} | ${s.failures} | ${pct(s.fieldAccuracy)} | ${pct(s.credentialAccuracy)} | ${pct(s.restrictedRecall)} | ${s.calibration.calibrated ? 'yes' : 'NO'} |`,
    );
  }
  lines.push('');
  lines.push(
    `Calibration means fields marked \`pending\` are wrong more often than fields marked \`extracted\`. ` +
      `text_layer: pending ${pct(report.splits.text_layer.calibration.pendingErrorRate)} wrong vs extracted ${pct(report.splits.text_layer.calibration.extractedErrorRate)} wrong. ` +
      `scan: pending ${pct(report.splits.scan.calibration.pendingErrorRate)} vs extracted ${pct(report.splits.scan.calibration.extractedErrorRate)}.`,
  );
  lines.push('');
  lines.push('### Field accuracy by document kind');
  lines.push('');
  const kinds = [...new Set([...Object.keys(report.splits.text_layer.byKind), ...Object.keys(report.splits.scan.byKind)])].sort();
  lines.push('| Document kind | text_layer | scan |');
  lines.push('|---|---:|---:|');
  for (const kind of kinds) {
    const t = report.splits.text_layer.byKind[kind];
    const sc = report.splits.scan.byKind[kind];
    lines.push(
      `| ${kind} | ${t ? `${pct(t.accuracy)} (${t.correct}/${t.total})` : '-'} | ${sc ? `${pct(sc.accuracy)} (${sc.correct}/${sc.total})` : '-'} |`,
    );
  }
  lines.push('');

  lines.push('## Injection');
  lines.push('');
  lines.push(`${report.injection.passed} of ${report.injection.cases} cases held.`);
  if (report.injection.failures.length > 0) {
    lines.push('');
    for (const failure of report.injection.failures) lines.push(`- ${failure}`);
  }
  lines.push('');

  lines.push('## Judge');
  lines.push('');
  if (report.judge === null) {
    lines.push(
      'The judge did not run, so free-text fields were scored by exact comparison only and ' +
        'there is no agreement rate for this run. This is not a score of 100%: the metric is absent, not perfect.',
    );
  } else if (report.judge.scored === 0) {
    lines.push('No free-text field missed an exact comparison, so the judge had nothing to grade.');
  } else {
    lines.push(`${report.judge.scored} free-text values judged; ${pct(report.judge.agreementRate)} matched the expected value.`);
  }
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  if (comparison === null) {
    lines.push('| Metric | Value |');
    lines.push('|---|---:|');
    for (const key of Object.keys(report.metrics).sort()) lines.push(`| ${key} | ${report.metrics[key].toFixed(4)} |`);
  } else {
    lines.push(`Tolerance ${comparison.tolerance}; safety metrics compared exactly.`);
    lines.push('');
    lines.push('| Metric | Baseline | Current | Delta | |');
    lines.push('|---|---:|---:|---:|---|');
    const label = (m: string) =>
      comparison.regressions.some((d) => d.metric === m)
        ? 'REGRESSED'
        : comparison.improvements.some((d) => d.metric === m)
          ? 'improved'
          : '';
    for (const d of [...comparison.regressions, ...comparison.improvements, ...comparison.unchanged].sort((a, b) => a.metric.localeCompare(b.metric))) {
      lines.push(`| ${d.metric} | ${d.baseline.toFixed(4)} | ${d.current.toFixed(4)} | ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)} | ${label(d.metric)} |`);
    }
    if (comparison.notComparable.length > 0) {
      lines.push('');
      lines.push('Not comparable — one side has the metric and the other does not, so it counts neither way:');
      lines.push('');
      for (const metric of comparison.notComparable) {
        const side = report.metrics[metric] === undefined ? 'not measured in this run' : 'absent from the baseline';
        lines.push(`- \`${metric}\` (${side})`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
