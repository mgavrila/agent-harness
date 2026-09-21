export { surfaceSinks } from './domain/sinks.js';
export { loadSurfaces, surfacesOf, type LoadedSurfaces, type SurfaceSettings } from './domain/surfaces/registry.js';
export { postPendingApprovals, type PollDeps, type PollResult } from './domain/poller.js';
export {
  APPROVE_ACTION_ID,
  CARD_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  approvalCard,
  decidedCard,
  editForm,
  parseApprovalMetadata,
  payloadPreview,
  type ApprovalMetadata,
  type ApprovalRow,
} from './domain/cards.js';
/** The one restricted-value guard, from the package that owns the patterns. */
export { containsRestrictedPattern } from '@harness/core-tools/redaction';
export { createInProcessCoreToolsClient, type InProcessCoreToolsOptions } from './domain/execute/in-process.js';
export type { CoreToolsClient, ExecuteOutcome } from './domain/execute/types.js';
export {
  decideApproval,
  threadReplyText,
  type DecidedOutcome,
  type DecisionDeps,
  type DecisionInput,
  type DecisionResult,
} from './domain/decisions.js';
export { registerApprovalHandlers } from './domain/handlers.js';
export {
  collectHealth,
  runDispatchTick,
  runPollTick,
  runReconcileTick,
  startRunner,
  type HealthSnapshot,
  type RunnerDeps,
  type RunnerHandle,
  type RunnerIntervals,
  type RunnerLoopStatus,
  type RunnerStatus,
} from './domain/runner.js';
export { DEFAULT_HEALTH_BIND, startHealthServer, type HealthPayload, type HealthServer } from './domain/health.js';
