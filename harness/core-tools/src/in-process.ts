import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

/**
 * An MCP client wired straight to a server in this process, with no socket.
 * Used by the test fixtures and by the eval runner, which is not a vitest
 * process and so cannot rely on `onTestFinished` to clean up.
 */
export async function connectInProcess(factory: () => McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const handler = createMcpHandler(factory);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'in-process', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}
