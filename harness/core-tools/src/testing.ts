import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { connectInProcess } from './domain/tooling/in-process.js';
import { registerTools } from './domain/tooling/registry.js';
import { DEFAULT_POLICY } from './domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type AnyToolDef, type ToolDeps } from './domain/tooling/types.js';
import { registryOf } from './domain/packs/registry.js';
import { PACK_KERNEL } from './domain/packs/kernel.js';
import { kernelTools } from './tools/catalog.js';

/** The packs a test runs against: the shipped one, with no environment involved. */
const TEST_PACKS = registryOf([healthcarePack]);

export function makeTestDeps(db: Db, overrides: Partial<ToolDeps> = {}): ToolDeps {
  const deps: ToolDeps = {
    db,
    client: 'test',
    caller: 'test-caller',
    policy: { ...DEFAULT_POLICY },
    encryptionKey: randomBytes(32),
    now: () => new Date('2026-09-15T12:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
    // A throwaway directory per call, so a test that forgets to override it
    // still cannot write into the repository.
    storageDir: mkdtempSync(path.join(tmpdir(), 'harness-test-storage-')),
    formsDir: TEST_PACKS.formsDir(),
    restrictedToModel: false,
    sinks: {},
    context: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs: TEST_PACKS,
    ...overrides,
  };
  // After the spread: a test that passes its own `packs` gets that registry's kernel tools, and
  // one that passes its own `kernelTools` keeps them. `createCoreToolsServer` fills the same map
  // again with the same definitions, which is a no-op.
  if (deps.kernelTools.size === 0) {
    for (const tool of kernelTools(deps.packs)) deps.kernelTools.set(tool.name, tool);
  }
  return deps;
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

/**
 * The text content of a tool result, for asserting on the message a failure
 * put in front of the agent. Every block is joined, not just the first: a
 * `not.toContain` that read one block would pass on a leak in the next.
 */
export function textOf(res: { content?: unknown }): string {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

/** The one `useTestDb`, from the package that owns the truncation list. */
export { useTestDb } from '@harness/db/testing';
/** The fake lives beside the interface it implements; this is where tests reach it. */
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from './domain/models/fake.js';
