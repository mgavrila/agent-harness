import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { localParser } from './domain/documents/parser.js';
import { connectInProcess } from './domain/tooling/in-process.js';
import { registerTools } from './domain/tooling/registry.js';
import { DEFAULT_POLICY, mergePolicy } from './domain/tooling/policy.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type AnyToolDef,
  type RunContext,
  type ToolDeps,
} from './domain/tooling/types.js';
import { registryOf } from './domain/packs/registry.js';
import type { PackRegistry } from './domain/packs/types.js';
import { PACK_KERNEL } from './domain/packs/kernel.js';
import { kernelTools } from './tools/catalog.js';

/** The packs a test runs against: the shipped one, with no environment involved. */
const TEST_PACKS = registryOf([healthcarePack]);

/**
 * The environment every pack sees under test, before the packs add their own.
 *
 * Empty, and that is the point. A pack reads its configuration from `deps.env` and never from the
 * ambient one, so a test has to hand over a fixed map — but *which* variables need pinning is the
 * pack's knowledge, not this module's. Each pack declares them as `evals.testEnv`, and
 * `testPackEnv` below merges every loaded pack's over this base. Anything a future kernel
 * variable needs under test goes here; a pack's variable never does.
 */
export const TEST_PACK_ENV: Readonly<Record<string, string>> = {};

/**
 * The principal every test runs as unless it says otherwise. A practitioner, because that row of
 * `DEFAULT_POLICY` is exactly the flat table the kernel shipped before levels existed: `read`
 * auto, `write.internal` auto, `external` approval, `financial` blocked, `destructive` approval.
 * A test about levels passes its own principal with a different `level`.
 */
export const TEST_PRINCIPAL: Principal = {
  id: 'u-test',
  kind: 'user',
  level: 'practitioner',
  displayName: 'Test user',
  surfaces: {},
  attributes: {},
};

/**
 * The base map plus every loaded pack's `evals.testEnv`, in load order.
 *
 * A pack later in `HARNESS_PACKS` wins a collision, which matches how a registry answers
 * singular questions in load order elsewhere. Two packs pinning the same variable to different
 * values is a configuration nobody should ship, and the merge is not the place to discover it.
 */
export function testPackEnv(packs: PackRegistry): Readonly<Record<string, string>> {
  return Object.assign({}, TEST_PACK_ENV, ...packs.all.map((p) => p.evals?.testEnv ?? {})) as Record<string, string>;
}

/** No run opened. A test that asserts on `run_id` opens one with `openRun` and passes it as `context`. */
export const TEST_CONTEXT: RunContext = { runId: null, threadId: null, surface: null, conversation: null };

/** `Partial<ToolDeps>`, except that a partial context is merged over `TEST_CONTEXT` rather than replacing it. */
export type TestDepsOverrides = Partial<Omit<ToolDeps, 'context'>> & { context?: Partial<RunContext> };

export function makeTestDeps(db: Db, overrides: TestDepsOverrides = {}): ToolDeps {
  const { context, ...rest } = overrides;
  const packs = overrides.packs ?? TEST_PACKS;
  // A throwaway directory per call, so a test that forgets to override it
  // still cannot write into the repository.
  const storageDir = rest.storageDir ?? mkdtempSync(path.join(tmpdir(), 'harness-test-storage-'));
  const deps: ToolDeps = {
    db,
    client: 'test',
    principal: TEST_PRINCIPAL,
    policy: mergePolicy(DEFAULT_POLICY, {}),
    encryptionKey: randomBytes(32),
    now: () => new Date('2026-09-15T12:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
    storageDir,
    // Not a real directory: a test that syncs knowledge passes its own, and one that does not
    // gets a path that simply holds no `knowledge/` folder, which is an empty sync and not an error.
    clientDir: path.join(storageDir, 'client'),
    embedDims: 1_024,
    parser: localParser(storageDir),
    formsDir: TEST_PACKS.formsDir(),
    restrictedToModel: false,
    sinks: {},
    context: { ...TEST_CONTEXT, ...context },
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    // Resolved from `packs` above, not from `TEST_PACKS`, so a test that loads a second pack
    // gets that pack's pins too rather than only the shipped one's.
    env: testPackEnv(packs),
    ...rest,
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
/** The fake lives beside the contract whose wire shape it fakes; this is where kernel tests reach it. */
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from '@harness/runtime-api/testing';
