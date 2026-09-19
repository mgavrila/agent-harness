/**
 * The public API of @harness/host.
 *
 * This module and the `./testing` subpath are the whole of what another package may import.
 * Nothing here reaches into `app/`: the composition root reads the environment, opens a pool
 * and starts a process, and a consumer that imported it would drag all three into its own
 * startup.
 */

export { type Host, type HostBudget } from './domain/host.js';
export { loadRuntime } from './domain/runtime/registry.js';
export { WITHHELD, appendMessage, findOrCreateThread, recentHistory } from './domain/threads/repository.js';
export { HISTORY_MAX_CHARS, trimHistory } from './domain/threads/trim.js';
export { kernelSkillsDir, readSkillCatalogue } from './domain/skills.js';
export { readPersona } from './domain/persona.js';
export { openKernel } from './domain/kernel.js';
export {
  COST_CAP_EXCEEDED,
  EMPTY_REPLY,
  RUNTIME_FAILED,
  TIMED_OUT,
  UNAUTHORISED_TEXT,
  attachMessageHandlers,
  cancelRun,
  handleMessage,
  runTurn,
  serialize,
  type AbortReason,
  type TurnDelivery,
  type TurnEvent,
  type TurnInput,
  type TurnResult,
} from './domain/conversation.js';
export { decisionDeps, resumeOnDecision, resumeText } from './domain/resume.js';
export { nextRunAfter } from './domain/playbooks/schema.js';
export {
  CLAIM_BATCH,
  claimDuePlaybooks,
  finishPlaybookRun,
  syncPlaybooks,
  type ClaimedRun,
} from './domain/playbooks/repository.js';
export { preflightPlaybook, type PreflightResult } from './domain/playbooks/preflight.js';
export { playbookNoticeKey, stagePlaybookNotice } from './domain/playbooks/notice.js';
export {
  MAX_ATTEMPTS,
  SCHEDULER_TICK_MS,
  executePlaybook,
  playbookConversation,
  startScheduler,
  type SchedulerHandle,
  type SchedulerStatus,
  type TickResult,
} from './domain/playbooks/scheduler.js';
export {
  API_MAX_ATTACHMENTS,
  API_MAX_BODY_BYTES,
  API_MAX_TEXT_CHARS,
  API_THREAD_MESSAGES,
  DEFAULT_HOST_BIND,
  DEFAULT_HOST_PORT,
  SSE_KEEPALIVE_MS,
  type RunApiOptions,
  type RunApiServer,
} from './domain/api/types.js';
export { startRunApi } from './domain/api/server.js';
export { bearerOk, handleApiRequest } from './domain/api/routes.js';
