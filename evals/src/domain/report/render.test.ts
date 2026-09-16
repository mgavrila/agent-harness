import { describe, it, expect } from 'vitest';
import { buildReport, compareToBaseline } from './build.js';
import { renderMarkdown } from './render.js';
import { report } from './report.test-helpers.js';

describe('renderMarkdown', () => {
  it('leads with the verdict and names the serving model', () => {
    const md = renderMarkdown(
      report({ 'scan.field_accuracy': 0.91 }),
      compareToBaseline(report({ 'scan.field_accuracy': 0.91 }), report()),
    );
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
      pack: 'healthcare',
      recordKinds: ['provider'],
      servingModel: { extract: 'x', judge: 'y' },
      splits: report().splits,
      injection: { cases: 2, passed: 1, passRate: 0.5, failures: ['i1: called approvals_execute'] },
      judge: null,
      metricOverrides: {},
    });
    expect(renderMarkdown(r, null)).toContain('called approvals_execute');
  });
});
