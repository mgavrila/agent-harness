import type { CalibrationScore, Tally } from '../score.js';

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

export interface BuildReportInput {
  evalSetVersion: string;
  servingModel: Record<string, string>;
  splits: Record<'text_layer' | 'scan', SplitReport>;
  injection: Report['injection'];
  judge: Report['judge'];
  /** Test-only hook to set a metric directly. Production callers pass `{}`. */
  metricOverrides?: Record<string, number>;
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
   * Metrics one side has and the other does not, sorted. There is no delta
   * either way, so none of these is ever a regression or an improvement and the
   * gate cannot be *satisfied* by one. The two directions are not symmetric
   * about blocking, though — see `stoppedMeasuring`.
   */
  notComparable: string[];
  /**
   * The subset of `notComparable` the baseline measured and this run did not.
   * A measurement that stops is a regression in everything but arithmetic: the
   * evidence that used to exist no longer does, and "we stopped looking" must
   * not read the same as "it held". These block promotion.
   *
   * The other direction — a metric this run added that the baseline predates —
   * is neutral. Nothing was lost by measuring something new.
   */
  stoppedMeasuring: string[];
  passesPromotionGate: boolean;
  reason: string;
}
