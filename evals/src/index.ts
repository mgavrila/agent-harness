/**
 * The public API of @harness/evals.
 *
 * `app/cli.ts` is deliberately absent: it parses `process.argv` and resolves paths against the
 * repository root, which is composition-root work. Run it through `pnpm evals`.
 */
export { injectionCasesFor, runEvals, selectCases, type RunOptions } from './domain/orchestrate.js';
export {
  declaredToolsOf,
  loadExtractionCases,
  loadInjectionCases,
  loadJsonl,
  type ExpectedAttachment,
  type ExtractionCase,
  type InjectionCase,
} from './domain/cases.js';
export {
  KERNEL_PIPELINE_TOOLS,
  normalizeMasking,
  openPipeline,
  resolvePipelineTools,
  runCase,
  type OpenPipelineOptions,
  type PipelineHandle,
  type PipelineTools,
} from './domain/pipeline.js';
export {
  normalizeValue,
  scoreCalibration,
  scoreExtraction,
  scoreInjection,
  type CalibrationRow,
  type CalibrationScore,
  type CaseOutcome,
  type StoredAttachment,
  type StoredField,
  type Tally,
} from './domain/score.js';
export { judgeFreeText } from './domain/judge/verdict.js';
export { type JudgeItem, type JudgeResult, type JudgeVerdict } from './domain/judge/types.js';
export { DEFAULT_TOLERANCE, buildReport, compareToBaseline } from './domain/report/build.js';
export { renderMarkdown } from './domain/report/render.js';
export {
  METRIC_KEYS,
  type BaselineComparison,
  type BuildReportInput,
  type Delta,
  type Report,
  type SplitReport,
} from './domain/report/types.js';
