# @harness/evals

The offline measurement of the document pipeline. It ingests and extracts every document in a
synthetic corpus through the real core-tools server, scores what was _stored_ rather than what
the model said, and compares the result to a committed baseline.

## Layout

```
src/domain/cases.ts       load cases.jsonl and injection.jsonl; read a skill's declared tools
src/domain/pipeline.ts    the real MCP server in-process against a real database
src/domain/score.ts       field, credential, restricted-recall, calibration and injection scoring
src/domain/judge/         a second opinion on free-text misses: types, prompts, verdict
src/domain/report/        types (the metric keys), build (compare to baseline), render (markdown)
src/domain/orchestrate.ts runEvals: selection, the per-case loop, the report, the exit code
src/app/cli.ts            flag parsing and the `pnpm evals` entrypoint
src/index.ts              the public API
```

## Public API

`@harness/evals` is `src/index.ts` and has no subpath exports. It publishes five groups:

| Group     | Exports                                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| running   | `runEvals`, `selectCases`, `injectionCasesFor`, `type RunOptions`                                                                                                                                                                                                                                        |
| cases     | `loadExtractionCases`, `loadInjectionCases`, `loadJsonl`, `declaredToolsOf`, `INTAKE_SKILL_FILE`, `INTAKE_DECLARED_TOOLS`, `type ExtractionCase`, `type InjectionCase`, `type ExpectedCredential`                                                                                                        |
| pipeline  | `openPipeline`, `runCase`, `normalizeMasking`, `type PipelineHandle`, `type OpenPipelineOptions`                                                                                                                                                                                                         |
| scoring   | `scoreExtraction`, `scoreCalibration`, `scoreInjection`, `normalizeValue`, `judgeFreeText`, `FREE_TEXT_FIELDS`, `type Tally`, `type CalibrationScore`, `type CaseOutcome`, `type StoredField`, `type StoredCredential`, `type CalibrationRow`, `type JudgeItem`, `type JudgeResult`, `type JudgeVerdict` |
| reporting | `buildReport`, `compareToBaseline`, `renderMarkdown`, `DEFAULT_TOLERANCE`, `METRIC_KEYS`, `type Report`, `type SplitReport`, `type BuildReportInput`, `type BaselineComparison`, `type Delta`                                                                                                            |

`src/app/cli.ts` is deliberately absent: it parses `process.argv` and resolves paths against the
repository root, which is composition-root work. Run it through `pnpm evals`.

## Running it

```bash
pnpm synth            # generate the corpus first
pnpm evals            # scores it and writes evals/results/report.{json,md}
pnpm evals:baseline   # the same, then writes the report to evals/baseline.json
```

It uses its own database, `harness_evals`, because it truncates every table between cases.
The exit code is the CI contract: non-zero on a regression, on a metric the baseline measured
that this run did not, or on any failed injection case. "No baseline yet" is not a pass. The
rule it enforces, the tolerance and why no baseline is committed yet are in
[docs/promotion-gate.md](../docs/promotion-gate.md).

## Testing

```bash
pnpm --filter @harness/evals test
```

`startFakeGateway` from `@harness/core-tools/fake-gateway` stands in for the model; no test
calls a provider.
