import { ChatOpenAI } from '@langchain/openai';
import type { FilesystemPermission } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { RunModel } from '@harness/runtime-api';

/**
 * The built-in filesystem tools the model may see: enough to read a skill body and search the
 * seeded files, nothing that writes. `read_file` is required by the filesystem middleware in
 * every explicit list.
 */
export const READ_ONLY_FS_TOOLS = ['read_file', 'ls', 'glob', 'grep'] as const;

/** Belt and braces under the allowlist above: no write reaches the state backend either. */
export const DENY_ALL_WRITES: FilesystemPermission[] = [{ operations: ['write'], paths: ['/**'], mode: 'deny' }];

/**
 * Deep Agents publishes a `task` tool for delegating to subagents even when none are declared.
 * This run has none (spec 5.4), so the tool is removed from every model request; a tool the
 * model cannot see is a tool it cannot call.
 */
export function kernelToolFilter() {
  return createMiddleware({
    name: 'KernelToolFilter',
    wrapModelCall: (request, handler) => handler({ ...request, tools: request.tools.filter((t) => t.name !== 'task') }),
  });
}

/**
 * A chat model on one gateway deployment, named as the client document names it — never a route
 * name, which on a pooled host would be every tenant's deployment at once. The base URL is the
 * proxy's OpenAI-compatible endpoint; the key is the proxy's master key or this tenant's own, so
 * no vendor key is ever in this process; `user` is the principal id, which the proxy records as
 * the spender (spec decision 16).
 */
export function chatModel(model: RunModel, deployment: string): ChatOpenAI {
  return new ChatOpenAI({
    model: deployment,
    apiKey: model.apiKey,
    configuration: { baseURL: `${model.baseUrl.replace(/\/+$/, '')}/v1` },
    user: model.user,
    // No retry inside the SDK. A retry the run cannot see is a model call the budget does not
    // count and a wait the run timeout does not know about; the gateway retries a flaky
    // deployment on its own, and one that stays down is what `fallbackModel` is for.
    maxRetries: 0,
  });
}
