import type { BaselineComparison, Report } from './types.js';

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
  // Which pack, said out loud: the same metric name carries a different meaning for each, so a
  // report read on its own has to name what it measured.
  lines.push(`Pack: \`${report.pack}\` (record kinds: ${report.record_kinds.join(', ') || 'none'})`);
  lines.push('');
  lines.push(`Eval set version: \`${report.eval_set_version}\``);
  lines.push('');
  lines.push('| Route | Model that served this run |');
  lines.push('|---|---|');
  for (const [route, model] of Object.entries(report.serving_model)) lines.push(`| ${route} | \`${model}\` |`);
  lines.push('');

  lines.push('## Splits');
  lines.push('');
  lines.push('| Split | Cases | Failed | Fields | Attachments | Restricted recall | Calibrated |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const name of ['text_layer', 'scan'] as const) {
    const s = report.splits[name];
    lines.push(
      `| ${name} | ${s.cases} | ${s.failures} | ${pct(s.fieldAccuracy)} | ${pct(s.attachmentAccuracy)} | ${pct(s.restrictedRecall)} | ${s.calibration.calibrated ? 'yes' : 'NO'} |`,
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
  const kinds = [
    ...new Set([...Object.keys(report.splits.text_layer.byKind), ...Object.keys(report.splits.scan.byKind)]),
  ].sort();
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
    lines.push(
      `${report.judge.scored} free-text values judged; ${pct(report.judge.agreementRate)} matched the expected value.`,
    );
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
    for (const d of [...comparison.regressions, ...comparison.improvements, ...comparison.unchanged].sort((a, b) =>
      a.metric.localeCompare(b.metric),
    )) {
      lines.push(
        `| ${d.metric} | ${d.baseline.toFixed(4)} | ${d.current.toFixed(4)} | ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)} | ${label(d.metric)} |`,
      );
    }
    if (comparison.notComparable.length > 0) {
      lines.push('');
      lines.push('Not comparable — one side has the metric and the other does not, so neither counts as a delta:');
      lines.push('');
      for (const metric of comparison.notComparable) {
        const side = comparison.stoppedMeasuring.includes(metric)
          ? 'the baseline measured it and this run did not — blocks promotion'
          : 'new in this run, absent from the baseline — neutral';
        lines.push(`- \`${metric}\`: ${side}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
