# @harness/evals

The offline measurement of the document pipeline. It ingests and extracts every document in a
synthetic corpus through the real core-tools server, scores what was _stored_ rather than what
the model said, and compares the result to a committed baseline.

It imports no pack. `HARNESS_PACKS` names what is loaded, exactly as it does for a server, and
`--pack` picks one of them when several are; the corpus, the cases, the injection file, the
intake skill, the judged fields and the pipeline's tool names all come off that pack's
`evals` block. The report records which pack and which record kinds it measured, because the
same metric name carries a different meaning for each.

**The measured pack decides which tools the harness calls.** Not one of the three steps — ingest,
extract, read back — is named by a literal here. `evals.readback` names them and the keys their
results carry, each member falling back to the kernel's `documents_ingest`,
`documents_classify`, `documents_extract`, `records_get`, `record_id` and `attachments`. A pack
that ships no tools of its own may omit the block; healthcare declares all of it, because it
replaces the three document tools under the same names and renames the read to `providers_get`.
One key is resolved against the deployment rather than the measured pack alone: `Pack.replaces`
is process-wide, so the key the _extract result_ carries comes from whichever loaded pack
publishes that tool. That is why a second pack can be measured beside healthcare at all.

## Layout

```
src/domain/cases.ts       load cases.jsonl and injection.jsonl; read a skill's declared tools
src/domain/pipeline.ts    the real MCP server in-process against a real database
src/domain/score.ts       field, attachment, restricted-recall, calibration and injection scoring
src/domain/judge/         a second opinion on free-text misses: types, prompts, verdict
src/domain/report/        types (the metric keys), build (compare to baseline), render (markdown)
src/domain/orchestrate.ts runEvals: selection, the per-case loop, the report, the exit code
src/app/cli.ts            flag parsing and the `pnpm evals` entrypoint
src/index.ts              the public API
```

## Public API

`@harness/evals` is `src/index.ts` and has no subpath exports. It publishes five groups:

| Group     | Exports                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| running   | `runEvals`, `selectCases`, `injectionCasesFor`, `type RunOptions`                                                                                                                                                                                                                    |
| cases     | `loadExtractionCases`, `loadInjectionCases`, `loadJsonl`, `declaredToolsOf`, `type ExtractionCase`, `type InjectionCase`, `type ExpectedAttachment`                                                                                                                                  |
| pipeline  | `openPipeline`, `runCase`, `normalizeMasking`, `resolvePipelineTools`, `KERNEL_PIPELINE_TOOLS`, `type PipelineHandle`, `type OpenPipelineOptions`, `type PipelineTools`                                                                                                              |
| scoring   | `scoreExtraction`, `scoreCalibration`, `scoreInjection`, `normalizeValue`, `judgeFreeText`, `type Tally`, `type CalibrationScore`, `type CaseOutcome`, `type StoredField`, `type StoredAttachment`, `type CalibrationRow`, `type JudgeItem`, `type JudgeResult`, `type JudgeVerdict` |
| reporting | `buildReport`, `compareToBaseline`, `renderMarkdown`, `DEFAULT_TOLERANCE`, `METRIC_KEYS`, `type Report`, `type SplitReport`, `type BuildReportInput`, `type BaselineComparison`, `type Delta`                                                                                        |

`src/app/cli.ts` is deliberately absent: it parses `process.argv` and resolves paths against the
repository root, which is composition-root work. Run it through `pnpm evals`.

## Running it

```bash
pnpm synth            # generate the corpus first
pnpm evals            # scores it and writes evals/results/report.{json,md}
pnpm evals:baseline   # the same, then writes the report to evals/baseline.json

HARNESS_PACKS=@harness/pack-healthcare,@harness/pack-stories pnpm evals -- --pack=stories
```

The last line loads both packs and measures the second. Everything follows `--pack`: its corpus,
its cases, its judged fields, its tools and its `formsDir`. Load order decides nothing.

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
