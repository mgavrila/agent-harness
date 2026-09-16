/**
 * One fully populated report, for the two test files that need one.
 *
 * `build.test.ts` asserts on the metrics this shape flattens to and
 * `render.test.ts` asserts on the Markdown rendered from it, so they have to
 * agree on the numbers: a test that renders one report and checks the keys of
 * a different one proves nothing about the pair. They used to hold two copies.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and
 * the "no test imported by production" architecture rule matches on the name.
 */
import { buildReport } from './build.js';
import type { Report } from './types.js';

/** A calibrated split: the fields held back for a human are the ones that were wrong. */
const calibration = {
  pending: { total: 2, correct: 0, accuracy: 0 },
  extracted: { total: 8, correct: 7, accuracy: 0.875 },
  pendingErrorRate: 1,
  extractedErrorRate: 0.125,
  calibrated: true,
};

/**
 * Both splits scored, the injection set clean and the judge available, so
 * every key in `METRIC_KEYS` is present and a caller can move exactly the one
 * it cares about.
 *
 * `overrides` is not `Partial<Report['metrics']>`: a partial of an index
 * signature makes every value `number | undefined`, which `metricOverrides`
 * will not take.
 */
export function report(overrides: Record<string, number> = {}): Report {
  return buildReport({
    evalSetVersion: '1.0.0',
    servingModel: { extract: 'gemini/gemini-3-flash-preview', judge: 'groq/openai/gpt-oss-120b' },
    splits: {
      text_layer: {
        cases: 10,
        failures: 0,
        fieldAccuracy: 0.96,
        credentialAccuracy: 0.95,
        restrictedRecall: 1,
        byKind: {
          state_license: { total: 20, correct: 20, accuracy: 1 },
          w9: { total: 30, correct: 28, accuracy: 28 / 30 },
        },
        calibration,
      },
      scan: {
        cases: 10,
        failures: 1,
        fieldAccuracy: 0.87,
        credentialAccuracy: 0.8,
        restrictedRecall: 0.9,
        byKind: {
          state_license: { total: 20, correct: 18, accuracy: 0.9 },
          w9: { total: 30, correct: 25, accuracy: 25 / 30 },
        },
        calibration,
      },
    },
    injection: { cases: 2, passed: 2, passRate: 1, failures: [] },
    judge: { scored: 12, agreementRate: 0.83 },
    metricOverrides: overrides,
  });
}
