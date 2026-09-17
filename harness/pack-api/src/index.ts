/**
 * The contract between core and a pack.
 *
 * Everything here is either a type a pack declares, a function it calls, or the shape of
 * something core hands it. It depends on `@harness/shared` and zod, and on nothing else in the
 * workspace, so a pack that implements it never has to depend on `@harness/core-tools` — which
 * is what lets core load a pack by name at runtime instead of importing it at build time. See
 * ARCHITECTURE.md, "Adding a pack".
 */
/**
 * Re-exported from `@harness/shared`, which is where both contracts can reach them. A pack's
 * tool schema validates a `channel` argument with `CONVERSATION_ID_PATTERN`, and so does the
 * kernel's; a surface adapter validates the same string against its own, much narrower, shape at
 * dispatch, because only the adapter knows what its ids look like.
 */
export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';
export { ACTION_CLASSES, BEHAVIORS, type ActionClass, type Behavior, type Policy } from './policy.js';
export { definePackTool, type AnyToolDef, type ToolDef } from './tool.js';
export {
  ManifestFieldShape,
  parseManifest,
  refineFields,
  type ManifestChecks,
  type ManifestField,
} from './manifest.js';
export {
  ANY_DOCUMENT_KIND,
  ATTACHMENT_SLOTS,
  parseExtractionManifest,
  targetFor,
  type AttachmentSlot,
  type ExtractionManifest,
  type ExtractionTarget,
} from './extraction.js';
export {
  ATTACHMENT_PROPERTIES,
  defineAttachmentKind,
  defineRecordKind,
  parseAttachmentKind,
  parseRecordKind,
  type AttachmentKindSpec,
  type AttachmentProperty,
  type ExternalIdSpec,
  type RawAttachmentKind,
  type RawRecordKind,
  type RecordKindSpec,
  type UnparsedKind,
} from './records.js';
export {
  type CoreToolView,
  type DeadlineItem,
  type DeadlinesComputeResult,
  type DeadlinesUpcomingResult,
  type DocumentRecordView,
  type DocumentsClassifyResult,
  type DocumentsExtractResult,
  type DocumentsIngestResult,
  type PackKernel,
  type PackRegistryView,
  type PackToolDeps,
  type RecordAttachmentView,
  type RecordFieldView,
  type RecordsGetResult,
  type RecordsListPendingResult,
  type RecordsSearchResult,
  type RecordsUpsertResult,
  type StagedRelease,
  type WriteOutFileInput,
  type WrittenFile,
} from './kernel.js';
export { type EvalReadback, type PackEvals } from './evals.js';
export { definePack, type Pack } from './pack.js';
