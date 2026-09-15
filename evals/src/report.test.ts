import { describe, it, expect } from 'vitest';
import { METRIC_KEYS, buildReport, compareToBaseline, renderMarkdown, type Report } from './report.js';

const emptyCalibration = {
  pending: { total: 2, correct: 0, accuracy: 0 },
  extracted: { total: 8, correct: 7, accuracy: 0.875 },
  pendingErrorRate: 1,
  extractedErrorRate: 0.125,
  calibrated: true,
};

// Not `Partial<Report['metrics']>`: a partial of an index signature makes every
// value `number | undefined`, which `metricOverrides` will not take.
function report(overrides: Record<string, number> = {}): Report {
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
        byKind: { state_license: { total: 20, correct: 20, accuracy: 1 }, w9: { total: 30, correct: 28, accuracy: 28 / 30 } },
        calibration: emptyCalibration,
      },
      scan: {
        cases: 10,
        failures: 1,
        fieldAccuracy: 0.87,
        credentialAccuracy: 0.8,
        restrictedRecall: 0.9,
        byKind: { state_license: { total: 20, correct: 18, accuracy: 0.9 }, w9: { total: 30, correct: 25, accuracy: 25 / 30 } },
        calibration: emptyCalibration,
      },
    },
    injection: { cases: 2, passed: 2, passRate: 1, failures: [] },
    judge: { scored: 12, agreementRate: 0.83 },
    metricOverrides: overrides,
  });
}

describe('buildReport', () => {
  it('flattens every scored number into metrics under a stable key', () => {
    const r = report();
    for (const key of METRIC_KEYS) expect(r.metrics).toHaveProperty(key);
    expect(r.metrics['text_layer.field_accuracy']).toBe(0.96);
    expect(r.metrics['scan.field_accuracy']).toBe(0.87);
    expect(r.metrics['injection.pass_rate']).toBe(1);
    expect(r.metrics['judge.agreement_rate']).toBe(0.83);
    expect(r.metrics['text_layer.calibrated']).toBe(1);
  });

  it('records which model served the run, because a score without one means nothing', () => {
    expect(report().serving_model.extract).toBe('gemini/gemini-3-flash-preview');
  });
});

describe('compareToBaseline', () => {
  const base = report();

  it('finds no change against itself and refuses promotion, because nothing improved', () => {
    const c = compareToBaseline(base, base);
    expect(c.regressions).toEqual([]);
    expect(c.improvements).toEqual([]);
    expect(c.passesPromotionGate).toBe(false);
    expect(c.reason).toMatch(/no metric improved/i);
  });

  it('promotes when one split improves and neither regresses', () => {
    const better = report({ 'scan.field_accuracy': 0.91 });
    const c = compareToBaseline(better, base);
    expect(c.improvements.map((d) => d.metric)).toContain('scan.field_accuracy');
    expect(c.regressions).toEqual([]);
    expect(c.passesPromotionGate).toBe(true);
  });

  it('refuses promotion when the other split regressed, however big the win', () => {
    const mixed = report({ 'scan.field_accuracy': 0.99, 'text_layer.field_accuracy': 0.8 });
    const c = compareToBaseline(mixed, base);
    expect(c.regressions.map((d) => d.metric)).toEqual(['text_layer.field_accuracy']);
    expect(c.passesPromotionGate).toBe(false);
    expect(c.reason).toMatch(/regressed/);
  });

  it('treats a move inside the tolerance as unchanged', () => {
    const noise = report({ 'scan.field_accuracy': 0.865 });
    const c = compareToBaseline(noise, base, 0.01);
    expect(c.regressions).toEqual([]);
    expect(c.unchanged.map((d) => d.metric)).toContain('scan.field_accuracy');
  });

  it('treats a dropped injection case as a regression whatever the tolerance', () => {
    const leaky = report({ 'injection.pass_rate': 0.5 });
    const c = compareToBaseline(leaky, base, 0.9);
    expect(c.regressions.map((d) => d.metric)).toContain('injection.pass_rate');
    expect(c.passesPromotionGate).toBe(false);
  });

  it('treats losing calibration as a regression', () => {
    const uncalibrated = report({ 'text_layer.calibrated': 0 });
    expect(compareToBaseline(uncalibrated, base).regressions.map((d) => d.metric)).toContain('text_layer.calibrated');
  });

  it('handles a baseline that predates a metric', () => {
    const old = report();
    delete old.metrics['judge.agreement_rate'];
    const c = compareToBaseline(report(), old);
    expect(c.regressions).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  it('leads with the verdict and names the serving model', () => {
    const md = renderMarkdown(report({ 'scan.field_accuracy': 0.91 }), compareToBaseline(report({ 'scan.field_accuracy': 0.91 }), report()));
    expect(md.split('\n')[0]).toMatch(/^# /);
    expect(md).toMatch(/PROMOTE|HOLD/);
    expect(md).toContain('gemini/gemini-3-flash-preview');
    expect(md).toContain('| text_layer.field_accuracy |');
  });

  it('renders without a baseline', () => {
    expect(renderMarkdown(report(), null)).toContain('no baseline');
  });

  it('breaks field accuracy down by document kind without putting it in the gate', () => {
    const r = report();
    const md = renderMarkdown(r, null);
    expect(md).toContain('Field accuracy by document kind');
    expect(md).toContain('| state_license | 100.0% (20/20) | 90.0% (18/20) |');
    expect(Object.keys(r.metrics).some((k) => k.includes('state_license'))).toBe(false);
  });

  it('lists the injection failures verbatim', () => {
    const r = buildReport({
      evalSetVersion: '1.0.0',
      servingModel: { extract: 'x', judge: 'y' },
      splits: report().splits,
      injection: { cases: 2, passed: 1, passRate: 0.5, failures: ['i1: called approvals_execute'] },
      judge: null,
      metricOverrides: {},
    });
    expect(renderMarkdown(r, null)).toContain('called approvals_execute');
  });
});
