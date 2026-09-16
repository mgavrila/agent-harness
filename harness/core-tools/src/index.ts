/**
 * The public API of @harness/core-tools.
 *
 * This module and the subpaths in `package.json#exports` are the whole of what another
 * package may import. Nothing here reaches into `app/`: the composition root reads the
 * environment, opens a pool and starts a process, and a consumer that imported it would drag
 * all three into its own startup.
 *
 * Adding an export is a deliberate widening of the surface. Ask first whether the caller
 * wants a *fake* instead, which belongs under `./testing`.
 */

// --- The tooling kernel -------------------------------------------------------------------
export { defineTool, registerTools } from './domain/tooling/registry.js';
export { auditBaseFor, preservingContext, withCurrentTool } from './domain/tooling/context.js';
export { hashArgs, writeAudit, type AuditEntry, type Decision } from './domain/tooling/audit.js';
export {
  ACTION_CLASSES,
  BEHAVIORS,
  DEFAULT_POLICY,
  decide,
  loadPolicy,
  parsePolicy,
  type ActionClass,
  type Behavior,
  type Policy,
} from './domain/tooling/policy.js';
export { expireApprovals, parkStuckDispatches, reconcile, type ReconcileResult } from './domain/tooling/reconcile.js';
export { connectInProcess } from './domain/tooling/in-process.js';
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type AnyToolDef,
  type AuditBase,
  type SessionContext,
  type ToolDef,
  type ToolDeps,
} from './domain/tooling/types.js';

// --- The tool catalogue -------------------------------------------------------------------
export { ALL_TOOLS, createCoreToolsServer } from './tools/catalog.js';

// --- Domains ------------------------------------------------------------------------------
export { createOrReuseApproval } from './domain/approvals/repository.js';
export { executeApproval, type ExecutedApproval } from './domain/approvals/execute.js';
export {
  CREDENTIAL_KINDS,
  LEAD_DAYS,
  URGENCY_BUCKETS,
  addDays,
  bucketFor,
  computeDeadlines,
  daysUntil,
  digestKeyFor,
  type CredentialKind,
  type UrgencyBucket,
} from './domain/deadlines/compute.js';
export {
  DOCUMENT_KINDS,
  type DocumentKind,
  type ExtractedText,
  type PageText,
  type ParsedExtraction,
} from './domain/documents/types.js';
export { loadHealthcareManifest, parseManifest, type ProviderManifest } from './domain/documents/manifest.js';
export { dispatchStagedEffects, stageEffect } from './domain/effects/outbox.js';
export {
  type DispatchOptions,
  type DispatchResult,
  type SinkHandler,
  type SinkRegistry,
  type StageEffectInput,
} from './domain/effects/types.js';
export { defaultFormsDir, getTemplate, loadManifest, mappingLabel } from './domain/forms/templates.js';
export { fillTemplatePdf, latestCredential, resolveMappings } from './domain/forms/fill.js';
export { buildRosterCsv } from './domain/forms/roster.js';
export {
  ROSTER_COLUMNS,
  type FormTemplate,
  type ProviderData,
  type ResolvedMapping,
  type RosterRow,
  type TemplateManifest,
  type TemplateMapping,
} from './domain/forms/types.js';
export { callModel, callModelJson, gatewayFromEnv, httpGateway } from './domain/models/gateway.js';
export {
  ROUTES,
  type GatewayConfig,
  type JsonSchemaSpec,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelGateway,
  type ModelMessage,
  type Route,
} from './domain/models/types.js';
export { requireProvider, upsertProviderRecord } from './domain/providers/repository.js';
export {
  CredentialInput,
  FieldInput,
  type UpsertProviderInput,
  type UpsertProviderResult,
} from './domain/providers/types.js';
export { contentTag, documentTextPath, outRoot, storageRoot, toStorageRelative } from './domain/storage/layout.js';
export {
  fileStorage,
  readDocumentBytes,
  resolveOutFile,
  resolveStoragePath,
  sha256File,
  writeOutFile,
} from './domain/storage/file-store.js';
export { type Storage, type WriteFileInput, type WrittenFile } from './domain/storage/types.js';
export { namesMatch } from './domain/verify/names.js';
export { NPPES_DEFAULT_BASE_URL, nppesRegistry } from './domain/verify/nppes.js';
export { type NppesRecord, type VerifyConfig, type VerifyRegistry } from './domain/verify/types.js';

// --- Shared helpers, for the packages above this one ---------------------------------------
export { ConfigError, ModelOutputError, ToolError, describeError } from '@harness/shared';
export { booleanFromEnv, numberFromEnv, optionalEnv, requiredEnv, type NumberEnvOptions } from '@harness/shared';
export { createLogger, type Logger } from '@harness/shared';
export { assertInsideRoot, realOrNearestAncestor, type EscapeReason, type InsideRootOptions } from '@harness/shared';
export { runBounded, type RunBoundedOptions, type RunBoundedOutcome } from '@harness/shared';
export { readJsonl, writeJsonl, type JsonlRow } from '@harness/shared';
export { csvCell } from '@harness/shared';
export { containsRestrictedPattern, isValidDea, type RestrictedKind } from './shared/redaction/patterns.js';
export { MASKED, isRestrictedName } from './shared/redaction/names.js';
export {
  assertRedacted,
  fieldNameFor,
  redactPages,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './shared/redaction/text.js';
