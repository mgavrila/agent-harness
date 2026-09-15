import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { createDb, type Db } from '@harness/db';
import { TEST_DATABASE_URL, resetDatabase } from '@harness/db/testing';
import { DEFAULT_POLICY } from './policy.js';
import type { ToolDeps } from './registry.js';

export function makeTestDeps(db: Db, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    db,
    client: 'test',
    caller: 'test-caller',
    policy: { ...DEFAULT_POLICY },
    encryptionKey: randomBytes(32),
    now: () => new Date('2026-09-15T12:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: 0.85,
    ...overrides,
  };
}

export async function makeTestClient(factory: () => McpServer) {
  const handler = createMcpHandler(factory);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

export function openTestDb() {
  const handle = createDb(TEST_DATABASE_URL);
  return { ...handle, reset: () => resetDatabase(handle.db) };
}
