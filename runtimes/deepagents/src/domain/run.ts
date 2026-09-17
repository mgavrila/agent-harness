import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createDeepAgent, createFilesystemMiddleware } from 'deepagents';
import { modelFallbackMiddleware } from 'langchain';
import type { Logger } from '@harness/shared';
import type { RunEvent, RunRequest } from '@harness/runtime-api';
import { bridgeTools } from './bridge.js';
import type { EventQueue } from './events.js';
import { inputText, seedFiles } from './files.js';
import { DENY_ALL_WRITES, READ_ONLY_FS_TOOLS, chatModel, kernelToolFilter } from './middleware.js';
import { systemPrompt } from './prompt.js';

export interface RunContext {
  checkpointer: BaseCheckpointSaver;
  log: Logger;
}

const BUDGET_MESSAGE = 'the run exceeded its budget';
const FAILED_MESSAGE = 'the run failed; see the host log';

/** A skill activation is a `read_file` under `/skills/<name>/`; the version is the host's. */
const SKILL_PATH = /^\/skills\/([^/]+)\//;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

function historyMessages(request: RunRequest): BaseMessage[] {
  return request.history.map((turn) =>
    turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content),
  );
}

/**
 * One run of the Deep Agents loop, from the request to a closed queue.
 *
 * The agent is built per run because everything about it is per run: the model carries the
 * principal as `user`, the tools are this run's kernel, the prompt is this client's persona.
 * Only the checkpointer is shared, keyed by the thread. Continuity is the checkpoint's; the
 * history on the request is used once, for a thread with no checkpoint yet (decision 7).
 *
 * Events come from two places. The bridge emits every kernel tool call and result and counts them
 * against the budget. This function reads the `messages` stream for text deltas and usage and the
 * `updates` stream for model turns — counted against the budget, and watched for the `read_file`
 * of a skill body, which is what `skill_activated` means here (decision 6).
 *
 * Exactly one terminal event, always: `done` with the run's text, or `error` with one of three
 * fixed messages. The framework's and the gateway's own messages go to the log and never into
 * an event, because an event reaches a surface (decision 9).
 */
export async function runDeepAgent(request: RunRequest, ctx: RunContext, queue: EventQueue<RunEvent>): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(request.budget.timeoutMs)]);
  let exceeded = false;
  const exceed = (): void => {
    exceeded = true;
    controller.abort();
  };
  const turns: string[][] = [];
  let modelCalls = 0;
  const activated = new Set<string>();

  try {
    const tools = await bridgeTools(request.tools, {
      emit: (e) => queue.push(e),
      maxToolCalls: request.budget.maxToolCalls,
      onBudgetExceeded: exceed,
    });
    const model = chatModel(request.model, request.model.route);
    const middleware = [
      // The permissions go on this middleware, not only on `createDeepAgent`: a custom middleware
      // named `FilesystemMiddleware` REPLACES the default one, and the agent's own `permissions`
      // are an argument to the default it just replaced. Passed in both places, the denial holds
      // for this agent and for the subagent specs the framework builds behind it.
      createFilesystemMiddleware({ tools: READ_ONLY_FS_TOOLS, permissions: DENY_ALL_WRITES }),
      kernelToolFilter(),
      ...(request.model.fallbackRoute
        ? [modelFallbackMiddleware(chatModel(request.model, request.model.fallbackRoute))]
        : []),
    ];
    const agent = createDeepAgent({
      model,
      tools,
      systemPrompt: systemPrompt(request.persona),
      skills: ['/skills/'],
      memory: ['/memories/MEMORY.md'],
      checkpointer: ctx.checkpointer,
      permissions: DENY_ALL_WRITES,
      middleware,
    });

    const config = { configurable: { thread_id: request.threadId } };
    const fresh = (await ctx.checkpointer.getTuple(config)) === undefined;
    const messages: BaseMessage[] = [...(fresh ? historyMessages(request) : []), new HumanMessage(inputText(request))];
    const files = await seedFiles(request);

    const stream = (await agent.stream(
      { messages, files },
      {
        ...config,
        streamMode: ['messages', 'updates'],
        signal,
        recursionLimit: 2 * request.budget.maxModelCalls + 10,
      },
    )) as AsyncIterable<[string, unknown]>;

    for await (const [mode, payload] of stream) {
      if (mode === 'messages') {
        const [chunk] = payload as [BaseMessage, unknown];
        if (!(chunk instanceof AIMessageChunk || chunk instanceof AIMessage)) continue;
        const delta = contentText(chunk.content);
        if (delta !== '') {
          if (turns.length === 0) turns.push([]);
          turns[turns.length - 1].push(delta);
          queue.push({ type: 'text', delta });
        }
        const usage = chunk.usage_metadata;
        if (usage) {
          queue.push({
            type: 'usage',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            costUsd: 0,
          });
        }
        continue;
      }
      const update = payload as Record<string, { messages?: BaseMessage[] } | undefined>;
      if (!('model_request' in update)) continue;
      modelCalls += 1;
      turns.push([]);
      if (modelCalls > request.budget.maxModelCalls) exceed();
      for (const message of update.model_request?.messages ?? []) {
        if (!(message instanceof AIMessage || message instanceof AIMessageChunk)) continue;
        for (const call of message.tool_calls ?? []) {
          if (call.name !== 'read_file') continue;
          const filePath = (call.args as { file_path?: unknown }).file_path;
          const match = typeof filePath === 'string' ? SKILL_PATH.exec(filePath) : null;
          const skill = match && request.skills.find((s) => s.name === match[1]);
          if (!skill || activated.has(skill.name)) continue;
          activated.add(skill.name);
          queue.push({ type: 'skill_activated', name: skill.name, version: skill.version });
        }
      }
    }
    if (exceeded) {
      queue.push({ type: 'error', message: BUDGET_MESSAGE });
      return;
    }
    queue.push({
      type: 'done',
      text: turns
        .map((t) => t.join(''))
        .filter((t) => t !== '')
        .join('\n\n'),
    });
  } catch (err) {
    if (request.signal.aborted) queue.push({ type: 'error', message: 'cancelled' });
    else if (exceeded) queue.push({ type: 'error', message: BUDGET_MESSAGE });
    else if ((signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') {
      queue.push({ type: 'error', message: 'the run timed out' });
    } else {
      ctx.log.error(`run ${request.runId} failed`, err);
      queue.push({ type: 'error', message: FAILED_MESSAGE });
    }
  } finally {
    queue.close();
  }
}
