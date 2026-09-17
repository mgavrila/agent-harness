import type { Client } from '@modelcontextprotocol/client';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { JsonSchema7Type } from '@langchain/core/utils/json_schema';
import { hashArgs } from '@harness/shared';
import type { RunEvent } from '@harness/runtime-api';

export interface BridgeSink {
  emit(event: RunEvent): void;
  maxToolCalls: number;
  /** Called once, on the first call past the budget. The caller aborts the run. */
  onBudgetExceeded(): void;
  /**
   * The run's signal: cancel, the budget and the timeout all end here. It is handed to every
   * `callTool`, so a cancel stops the client waiting on a kernel tool that is still executing
   * instead of leaving the call to land on a run that has already closed.
   */
  signal: AbortSignal;
}

interface CallResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

/** The text parts of a tool result, joined: what the model reads. */
export function textOf(res: { content?: unknown }): string {
  const parts = Array.isArray(res.content) ? (res.content as { type?: string; text?: string }[]) : [];
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('\n');
}

function statusOf(res: CallResult): 'ok' | 'pending' | 'error' {
  if (res.isError) return 'error';
  const status = (res.structuredContent as { status?: unknown } | undefined)?.status;
  return status === 'pending' ? 'pending' : 'ok';
}

/**
 * The kernel's tools, as LangChain tools the agent can call.
 *
 * Every invocation goes through the one `Client` the host handed over, so policy, audit and the
 * outbox are the kernel's business and the runtime has no other route into anything (spec
 * invariant 9). The bridge is also where the run learns a tool was called: it emits `tool_call`
 * before and `tool_result` after, and it counts the calls against the budget. The result is
 * handed to the model as the kernel's own text — a `pending` envelope or a "Tool x failed" line
 * — never reshaped, so what the model reads is what the audit row says.
 */
export async function bridgeTools(client: Client, sink: BridgeSink): Promise<StructuredToolInterface[]> {
  const { tools } = await client.listTools();
  let calls = 0;
  let exceeded = false;
  return (tools as { name: string; description?: string; inputSchema: unknown }[]).map((def) =>
    tool(
      async (input: Record<string, unknown>) => {
        calls += 1;
        if (calls > sink.maxToolCalls) {
          if (!exceeded) {
            exceeded = true;
            sink.onBudgetExceeded();
          }
          return 'This run has spent its tool-call budget; stop and report.';
        }
        sink.emit({ type: 'tool_call', name: def.name, argsHash: hashArgs(input) });
        let res: CallResult;
        try {
          res = await client.callTool({ name: def.name, arguments: input }, { signal: sink.signal });
        } catch (err) {
          // A rejection under an aborted signal is the run ending, not the tool failing: no
          // `tool_result` is claimed for a call whose outcome nobody waited for, and the rejection
          // propagates so the graph stops here rather than telling the model the tool broke.
          if (sink.signal.aborted) throw err;
          sink.emit({ type: 'tool_result', name: def.name, status: 'error' });
          return `Tool ${def.name} could not be reached: ${err instanceof Error ? err.name : 'error'}.`;
        }
        sink.emit({ type: 'tool_result', name: def.name, status: statusOf(res) });
        return textOf(res);
      },
      { name: def.name, description: def.description ?? '', schema: def.inputSchema as JsonSchema7Type },
    ),
  );
}
