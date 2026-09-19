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
export { auditBaseFor, withCurrentTool } from './domain/tooling/context.js';
export { hashArgs, writeAudit, type AuditEntry, type Decision } from './domain/tooling/audit.js';
export {
  ACTION_CLASSES,
  BEHAVIORS,
  DEFAULT_POLICY,
  decide,
  loadPolicy,
  mergePolicy,
  parsePolicy,
  type ActionClass,
  type Behavior,
  type ClassTable,
  type LevelOverrides,
  type Policy,
  type PolicyOverrides,
} from './domain/tooling/policy.js';
export { expireApprovals, parkStuckDispatches, reconcile, type ReconcileResult } from './domain/tooling/reconcile.js';
export { connectInProcess } from './domain/tooling/in-process.js';
export { depsForRun, type KernelConfig, type RunDeps } from './domain/tooling/deps.js';
export { buildKernelConfig, clientDirFor } from './domain/tooling/config.js';
export { configSourceNameFrom, loadConfigSource, type ConfigSourceDeps } from './domain/config/registry.js';
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type AnyToolDef,
  type AuditBase,
  type RunContext,
  type ToolDef,
  type ToolDeps,
} from './domain/tooling/types.js';

// --- The tool catalogue -------------------------------------------------------------------
export { createCoreToolsServer, kernelTools, publishedTools } from './tools/catalog.js';

// --- Domains ------------------------------------------------------------------------------
export { closeRun, openRun, type OpenRunInput, type RunStatus } from './domain/session/repository.js';
export { createOrReuseApproval } from './domain/approvals/repository.js';
export { assertNoInjection, findInjection, type InjectionCategory } from './domain/memory/injection.js';
export {
  MEMORY_CAPS,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_SCOPES,
  SESSION_SEARCH_LIMIT,
  type MemoryEntry,
  type MemoryScope,
  type MemoryUsage,
  type SessionHit,
} from './domain/memory/types.js';
export { addMemory, findMemoryEntry, listMemory, memoryUsage, removeMemory } from './domain/memory/repository.js';
export { memorySnapshot, renderMemorySnapshot } from './domain/memory/render.js';
export { searchSessions } from './domain/memory/search.js';
export { EMBED_BATCH, assertEmbedDims, embedTexts } from './domain/knowledge/embed.js';
export {
  KNOWLEDGE_DEFAULT_K,
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_SOURCE_KIND,
  KNOWLEDGE_SOURCE_NAME,
  RRF_K,
  SERVICE_RANK,
  levelRank,
  type KnowledgeHit,
  type KnowledgeSkip,
  type KnowledgeSkipKind,
  type KnowledgeSyncResult,
  type ParsedKnowledgeDocument,
} from './domain/knowledge/types.js';
export { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from './domain/knowledge/chunk.js';
export { parseKnowledgeDocument, readKnowledgeFolder } from './domain/knowledge/document.js';
export {
  findDocumentState,
  findOrCreateSource,
  isUnchanged,
  replaceChunks,
  tombstoneMissing,
  touchSource,
  upsertDocument,
  type DocumentChange,
} from './domain/knowledge/repository.js';
export { fuseByReciprocalRank, searchKnowledge, type KnowledgeCandidate } from './domain/knowledge/search.js';
export { syncKnowledge } from './domain/knowledge/sync.js';
export {
  PLAYBOOK_RUN_STATUSES,
  type PlaybookRow,
  type PlaybookRunRow,
  type PlaybookRunStatus,
  type PlaybookSummary,
} from './domain/playbooks/types.js';
export { findPlaybook, listPlaybooks, requestPlaybookRun, summarisePlaybook } from './domain/playbooks/repository.js';
export { executeApproval, type ExecutedApproval } from './domain/approvals/execute.js';
export {
  URGENCY_BUCKETS,
  addDays,
  bucketFor,
  computeDeadlines,
  daysUntil,
  digestKeyFor,
  type UrgencyBucket,
} from './domain/deadlines/compute.js';
export {
  type DocumentParser,
  type ExtractedText,
  type PageRange,
  type PageText,
  type ParsedDocument,
  type ParsedExtraction,
} from './domain/documents/types.js';
export { REMOTE_PARSE_TIMEOUT_MS, joinPages, localParser, remoteParser } from './domain/documents/parser.js';
export {
  parseAttachmentKindSpec,
  parseExtractionManifest,
  parseRecordKindSpec,
  type ExtractionManifest,
} from './domain/documents/manifest.js';
export { dispatchStagedEffects, stageEffect } from './domain/effects/outbox.js';
export {
  type DispatchOptions,
  type DispatchResult,
  type SinkHandler,
  type SinkRegistry,
  type StageEffectInput,
} from './domain/effects/types.js';
export { PACK_KERNEL } from './domain/packs/kernel.js';
export { loadPacks, registryOf } from './domain/packs/registry.js';
export { type PackRegistry, type ResolvedTarget } from './domain/packs/types.js';
export { callModel, callModelJson, gatewayFromEnv, httpGateway } from './domain/models/gateway.js';
export {
  EMBED_ROUTE,
  ROUTES,
  type GatewayConfig,
  type JsonSchemaSpec,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelGateway,
  type ModelMessage,
  type Route,
} from './domain/models/types.js';
export { requireRecord, upsertRecord } from './domain/records/repository.js';
export { AttachmentInput, FieldInput, type UpsertRecordInput } from './domain/records/types.js';
export { stageRelease, type StagedRelease } from './domain/files/release.js';
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

// --- The pack contract ----------------------------------------------------------------------
export { definePack, type Pack } from '@harness/pack-api';

// --- The identity contract ------------------------------------------------------------------
export { type Principal } from '@harness/identity-api';
export { loadIdentity } from './domain/identity/registry.js';
export { type IdentityDeps, type IdentitySession } from '@harness/identity-api';

// --- Shared helpers, for the packages above this one ---------------------------------------
export { ConfigError, ModelOutputError, ToolError, describeError } from '@harness/shared';
export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';
export { booleanFromEnv, numberFromEnv, optionalEnv, requiredEnv, type NumberEnvOptions } from '@harness/shared';
export { createLogger, type Logger } from '@harness/shared';
export { assertInsideRoot, realOrNearestAncestor, type EscapeReason, type InsideRootOptions } from '@harness/shared';
export { runBounded, type RunBoundedOptions, type RunBoundedOutcome } from '@harness/shared';
export { readJsonl, writeJsonl, type JsonlRow } from '@harness/shared';
export { csvCell } from '@harness/shared';
export {
  WITHHELD,
  containsRestrictedPattern,
  isValidDea,
  withholdRestrictedPatterns,
  type RestrictedKind,
} from './shared/redaction/patterns.js';
export { MASKED, isRestrictedName } from './shared/redaction/names.js';
export {
  assertRedacted,
  fieldNameFor,
  redactPages,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './shared/redaction/text.js';
