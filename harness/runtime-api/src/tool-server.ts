import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { RunRequest } from './types.js';

/** One tool an in-process fixture server publishes, declared with the JSON schema a client would see. */
export interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ToolServerFixture {
  client: Client;
  /** Every call the server received, in order. What "reaches tools only through request.tools" is asserted on. */
  calls: { name: string; args: Record<string, unknown> }[];
  close(): Promise<void>;
}

/**
 * An MCP server with exactly these tools, connected in-process to a client, with no socket. The
 * same transport `@harness/core-tools`' `connectInProcess` uses, written again here because this
 * package may not import the kernel and the kit has to hand a runtime a real `Client`.
 *
 * A handler's return value is the tool's text content, JSON-encoded, and — when it is an object
 * with a `status` — its structured content too, so the kernel's `{ status: 'pending', approval_id }`
 * envelope can be scripted exactly. A handler that throws becomes an `isError` result carrying the
 * message, which is what the kernel does for a `ToolError`.
 */
export async function toolServerFixture(tools: readonly FixtureTool[]): Promise<ToolServerFixture> {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fixture', version: '0.0.0' });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        // `registerTool` takes a standard schema (the kernel passes a zod object); zod v4 builds one
        // from the JSON schema the fixture declares, which is the shape a real client would list.
        {
          description: tool.description,
          inputSchema: z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema),
        },
        async (args) => {
          const parsedArgs = args as Record<string, unknown>;
          calls.push({ name: tool.name, args: parsedArgs });
          try {
            const out = await tool.handler(parsedArgs);
            const structured = out !== null && typeof out === 'object' ? (out as Record<string, unknown>) : undefined;
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(out) }],
              isError: false,
              structuredContent: structured,
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            };
          }
        },
      );
    }
    return server;
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://fixture.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'fixture-client', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    calls,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

/** A complete request with test defaults; `tools` is the one thing every test has to supply. */
export function fixtureRequest(over: Partial<RunRequest> & { tools: Client }): RunRequest {
  return {
    runId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    principal: { id: 'u-test', kind: 'user', level: 'practitioner', displayName: 'Test user' },
    input: { text: 'hello', attachments: [] },
    history: [],
    persona: 'You are the test assistant.',
    skills: [],
    memory: '',
    model: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', route: 'chat', user: 'u-test' },
    budget: { maxModelCalls: 10, maxToolCalls: 10, timeoutMs: 30_000 },
    signal: new AbortController().signal,
    ...over,
  };
}
