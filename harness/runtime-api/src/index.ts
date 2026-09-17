/**
 * The contract between the host and a runtime plug-in: the loop that turns a message into tool
 * calls and an answer. It depends on `@harness/shared`, zod and the MCP client type, and on
 * nothing else in the workspace, so a runtime never has to depend on core-tools or the host.
 * See ARCHITECTURE.md, "The host and the runtime".
 */
export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';
export { defineRuntime } from './runtime.js';
export type {
  RunAttachment,
  RunBudget,
  RunEvent,
  RunHandle,
  RunHistoryTurn,
  RunModel,
  RunPrincipal,
  RunRequest,
  RunSkill,
  Runtime,
  RuntimeDeps,
  RuntimeModule,
  RuntimeSession,
} from './types.js';
