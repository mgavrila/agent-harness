import {
  LOWER_IS_BETTER,
  ZERO_TOLERANCE,
  type BaselineComparison,
  type BuildReportInput,
  type Delta,
  type Report,
} from './types.js';

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
  const stoppedMeasuring: string[] = [];

  for (const metric of [...new Set([...Object.keys(report.metrics), ...Object.keys(baseline.metrics)])]) {
    const base = baseline.metrics[metric];
    const current = report.metrics[metric];
    // One side has it and the other does not: a metric the baseline predates,
    // or one this run did not measure. Neither is a delta, and neither may
    // stand in for one — but a measurement that stopped also blocks.
    if (base === undefined || current === undefined) {
      notComparable.push(metric);
      if (current === undefined) stoppedMeasuring.push(metric);
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
  stoppedMeasuring.sort();

  const blockers: string[] = [];
  if (regressions.length > 0) {
    blockers.push(`${regressions.length} metric(s) regressed: ${regressions.map((r) => r.metric).join(', ')}`);
  }
  if (stoppedMeasuring.length > 0) {
    blockers.push(
      `${stoppedMeasuring.length} metric(s) the baseline measured are missing from this run: ${stoppedMeasuring.join(', ')}`,
    );
  }

  const verdict =
    blockers.length > 0
      ? blockers.join('; ')
      : improvements.length === 0
        ? 'no metric improved, so there is nothing to promote'
        : `improved ${improvements.map((i) => i.metric).join(', ')} with no regression`;

  // A metric this run added is neutral, but still said out loud, so a comparison
  // that silently covered less ground than it looks like never reads as clean.
  const added = notComparable.filter((m) => !stoppedMeasuring.includes(m));
  const reason = added.length === 0 ? verdict : `${verdict} (new, not comparable: ${added.join(', ')})`;

  return {
    tolerance,
    regressions,
    improvements,
    unchanged,
    notComparable,
    stoppedMeasuring,
    passesPromotionGate: blockers.length === 0 && improvements.length > 0,
    reason,
  };
}
