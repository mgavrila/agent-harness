export { slackSinks } from './domain/sinks.js';
export { webClientApi } from './domain/slack/web-client.js';
export type { SlackApi } from './domain/slack/types.js';
export { postPendingApprovals, type PollDeps, type PollResult } from './domain/poller.js';
export { approvalBlocks, approvalFallbackText, decidedBlocks, payloadPreview } from './domain/render/blocks.js';
export { editModalView, parseEditModalMetadata } from './domain/render/modal.js';
export {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_MODAL_CALLBACK_ID,
  EDIT_NOTE_ACTION_ID,
  EDIT_NOTE_BLOCK_ID,
  type ApprovalRow,
  type EditModalMetadata,
} from './domain/render/types.js';
/** The one restricted-value guard, from the package that owns the patterns. */
export { containsRestrictedPattern } from '@harness/core-tools';
export { createMcpCoreToolsClient } from './domain/execute/mcp-client.js';
export type { CoreToolsClient, ExecuteOutcome, McpLauncher } from './domain/execute/types.js';
export {
  decideApproval,
  threadReplyText,
  type DecisionDeps,
  type DecisionInput,
  type DecisionResult,
} from './domain/decisions.js';
export {
  parseAllowedUsers,
  registerApprovalHandlers,
  type ActionArgs,
  type AppDeps,
  type HandlerRegistry,
  type ViewArgs,
} from './domain/slack/handlers.js';
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
export { DEFAULT_HEALTH_BIND, startHealthServer, type HealthServer } from './domain/health.js';
