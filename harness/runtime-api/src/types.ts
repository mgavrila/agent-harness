import type { Client } from '@modelcontextprotocol/client';
import type { EnvSource, Level, Logger } from '@harness/shared';

/**
 * Every declaration of the runtime contract, in one leaf module. The package's other modules take
 * their types from here and keep their own runtime functions, so no two of them can end up
 * importing each other. It imports types from `@harness/shared` and the MCP client, and nothing
 * else.
 */

/**
 * The message a runtime puts on its `error` event when the loop itself broke — it threw, or the
 * transport under it did — rather than when the run reached a verdict of its own such as a
 * cancel, a timeout or a spent budget. The host retries a firing that ends this way exactly once,
 * so the string is part of the contract and lives here, where the runtime that emits it and the
 * host that reads it both import the one copy instead of keeping two that can drift apart.
 */
export const RUN_FAILED_MESSAGE = 'the run failed; see the host log';

/** How one kernel tool call ended: it failed, a human has to approve it first, or it ran. */
export type ToolResultStatus = 'ok' | 'pending' | 'error';

/**
 * That status, read off an MCP tool result the way the host reads it: an `isError` result is the
 * kernel refusing or the tool failing, and a `{ status: 'pending', approval_id }` envelope is an
 * action parked for a human.
 *
 * Every runtime reads it here, so the scripted runtime and a model-backed one cannot end up
 * reporting the same result as two different things.
 */
export function toolResultStatus(result: { isError?: boolean; structuredContent?: unknown }): ToolResultStatus {
  if (result.isError) return 'error';
  const status = (result.structuredContent as { status?: unknown } | undefined)?.status;
  return status === 'pending' ? 'pending' : 'ok';
}

/** What the runtime learns as it runs. `error.message` is safe to post: never a payload value. */
export type RunEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; argsHash: string }
  | { type: 'tool_result'; name: string; status: ToolResultStatus }
  | { type: 'skill_activated'; name: string; version: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/**
 * Who the run acts as, as much of it as a runtime needs. Structurally a subset of the identity
 * contract's `Principal`, written out here because this leaf may not import that one.
 */
export interface RunPrincipal {
  readonly id: string;
  readonly kind: 'user' | 'service';
  readonly level: Level;
  readonly displayName: string;
}

/** A file the human attached. `path` is relative to `<storageDir>/incoming`. */
export interface RunAttachment {
  name: string;
  path: string;
}

/** One skill the runtime may offer: `dir` holds `SKILL.md`. */
export interface RunSkill {
  name: string;
  version: string;
  description: string;
  dir: string;
}

export interface RunHistoryTurn {
  role: 'user' | 'assistant' | 'host';
  content: string;
}

/** How to reach the model gateway for this run. `user` is sent on every request for attribution. */
export interface RunModel {
  baseUrl: string;
  apiKey: string;
  route: string;
  fallbackRoute?: string;
  user: string;
}

export interface RunBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface RunRequest {
  runId: string;
  threadId: string;
  principal: RunPrincipal;
  /** The human's message, or a playbook's prompt, or the host's resume notice. */
  input: { text: string; attachments: readonly RunAttachment[] };
  /** Prior turns of this thread, newest last, already trimmed to the host's budget. */
  history: readonly RunHistoryTurn[];
  /** The persona text (SOUL.md). */
  persona: string;
  skills: readonly RunSkill[];
  /** The curated memory snapshot, rendered by the host before the run starts and frozen for it. Empty when the principal has none. */
  memory: string;
  /** An MCP client already connected to a core-tools server built on this run's `ToolDeps`. */
  tools: Client;
  model: RunModel;
  budget: RunBudget;
  signal: AbortSignal;
}

export interface RunHandle {
  events: AsyncIterable<RunEvent>;
}

export interface RuntimeSession {
  readonly name: string;
  run(request: RunRequest): RunHandle;
  stop(): Promise<void>;
}

/** What a runtime is handed when it connects. `env` is the only environment it may read. */
export interface RuntimeDeps {
  env: EnvSource;
  log: Logger;
  databaseUrl: string;
  storageDir: string;
}

export interface Runtime {
  /** Lowercase, stable. */
  name: string;
  version: string;
  /** The environment variable names this runtime reads that are credentials. */
  secrets: readonly string[];
  connect(deps: RuntimeDeps): Promise<RuntimeSession>;
}

/** The module shape the host loads by name: `import(name)` resolves to `{ runtime }`. */
export interface RuntimeModule {
  runtime: Runtime;
}
