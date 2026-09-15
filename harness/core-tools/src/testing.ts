import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, onTestFinished } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { createDb, type Db } from '@harness/db';
import { TEST_DATABASE_URL, resetDatabase } from '@harness/db/testing';
import { DEFAULT_POLICY } from './policy.js';
import { connectInProcess } from './in-process.js';
import { registerTools, type AnyToolDef, type ToolDeps } from './registry.js';

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
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
    storageDir: '/nonexistent-storage-dir',
    restrictedToModel: false,
    verify: {
      nppesEnabled: true,
      // Unroutable by default: a test that wants a lookup starts its own stub
      // and overrides this, so no test can reach the real registry by accident.
      nppesBaseUrl: 'http://127.0.0.1:1/api/',
      stateLicenseEnabled: false,
      timeoutMs: 5_000,
    },
    sinks: {},
    context: {},
    tools: new Map(),
    ...overrides,
  };
}

/**
 * The database for one test file: emptied before each test and closed when the
 * file finishes. Call it once at module scope; test files run in their own
 * worker, so each gets its own pool.
 */
export function useTestDb(): Db {
  const { db, close } = createDb(TEST_DATABASE_URL);
  beforeEach(() => resetDatabase(db));
  afterAll(() => close());
  return db;
}

export type TestClient = Client;

/**
 * Connect an in-process MCP client to `factory` and close it, with its
 * handler, when the current test finishes — including when an assertion
 * throws, which a close written at the end of the test body would skip.
 */
export async function connectTestClient(factory: () => McpServer): Promise<TestClient> {
  const { client, close } = await connectInProcess(factory);
  onTestFinished(close);
  return client;
}

/** Connect a client to a server exposing exactly `tools` under `deps`. */
export function connectTools(name: string, tools: AnyToolDef[], deps: ToolDeps): Promise<TestClient> {
  return connectTestClient(() => {
    const server = new McpServer({ name, version: '0.0.0' });
    registerTools(server, tools, deps);
    return server;
  });
}

/** The `result` of an ok envelope, typed by the caller. Throws if the call did not succeed. */
export function resultOf<T>(res: { structuredContent?: unknown }): T {
  const envelope = res.structuredContent as { result?: T } | undefined;
  if (envelope?.result === undefined) {
    throw new Error(`expected an ok envelope with a result, got ${JSON.stringify(res.structuredContent)}`);
  }
  return envelope.result;
}

/** The `approval_id` of a pending envelope. Throws if the call was not parked for approval. */
export function approvalIdOf(res: { structuredContent?: unknown }): string {
  const envelope = res.structuredContent as { approval_id?: string } | undefined;
  if (envelope?.approval_id === undefined) {
    throw new Error(`expected a pending envelope with an approval id, got ${JSON.stringify(res.structuredContent)}`);
  }
  return envelope.approval_id;
}

export { startFakeGateway, type FakeGateway, type FakeGatewayCall, type FakeReply, type Responder } from './fake-gateway.js';
