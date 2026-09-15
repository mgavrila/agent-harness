import { randomBytes } from 'node:crypto';
import {
  DEFAULT_POLICY,
  createCoreToolsServer,
  type GatewayConfig,
  type Policy,
  type ToolDeps,
} from '@harness/core-tools';
import { connectInProcess } from '@harness/core-tools/in-process';
import { createDb, runMigrations, type Db } from '@harness/db';
import { resetDatabase } from '@harness/db/testing';
import type { ExtractionCase } from './cases.js';
import type { CaseOutcome, StoredCredential, StoredField } from './score.js';

export interface PipelineHandle {
  /** Calls a tool and records its name. Throws on an error envelope. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Every tool name called since the last reset, in order. */
  toolsCalled: string[];
  policy: Policy;
  db: Db;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenPipelineOptions {
  databaseUrl: string;
  /** The corpus root. Case paths are relative to it, and it is the tools' storage directory. */
  storageDir: string;
  gateway: GatewayConfig;
  client?: string;
}

/**
 * The real core-tools server, in this process, over the real MCP transport,
 * against a real database. The eval measures the shipping pipeline: policy,
 * audit, transactions and all. The only stand-in is the model gateway, which
 * the caller points wherever it likes.
 */
export async function openPipeline(opts: OpenPipelineOptions): Promise<PipelineHandle> {
  await runMigrations(opts.databaseUrl);
  const { db, close: closeDb } = createDb(opts.databaseUrl);
  const policy: Policy = { ...DEFAULT_POLICY };
  const toolsCalled: string[] = [];

  const deps: ToolDeps = {
    db,
    client: opts.client ?? 'evals',
    caller: 'eval-runner',
    policy,
    // Ephemeral: the eval database is truncated between cases and dropped
    // afterwards, so nothing encrypted here has to be readable later.
    encryptionKey: randomBytes(32),
    now: () => new Date(),
    approvalTtlHours: 24,
    confidenceThreshold: 0.85,
    gateway: opts.gateway,
    storageDir: opts.storageDir,
    restrictedToModel: false,
    verify: { nppesEnabled: false, nppesBaseUrl: 'http://127.0.0.1:1/api/', stateLicenseEnabled: false, timeoutMs: 5_000 },
    sinks: {},
    context: {},
    tools: new Map(),
  };

  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));

  return {
    toolsCalled,
    policy,
    db,
    async callTool(name, args) {
      toolsCalled.push(name);
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        const text = Array.isArray(res.content) ? JSON.stringify(res.content) : String(res.content);
        throw new Error(`${name} failed: ${text}`);
      }
      const envelope = res.structuredContent as { result?: unknown } | undefined;
      return envelope?.result;
    },
    async reset() {
      toolsCalled.length = 0;
      await resetDatabase(db);
    },
    async close() {
      await close();
      await closeDb();
    },
  };
}

interface ExtractResult {
  provider_id: string;
  document_kind: string;
  restricted_fields: string[];
}

interface ProviderResult {
  fields: StoredField[];
  credentials: StoredCredential[];
}

/**
 * `providers_get` masks a restricted field with a sentinel string
 * (`'[restricted]'`), never the plaintext, but the eval's own contract is
 * `null` for a masked field — see `StoredField.value`. Normalize here so the
 * scorer's `value !== null` check for "came back readable" means what it
 * says, rather than tripping on the sentinel every time.
 */
function normalizeMasking(fields: StoredField[]): StoredField[] {
  return fields.map((f) => (f.restricted ? { ...f, value: null } : f));
}

/**
 * One case: ingest the document, extract it, then read the provider back. The
 * read matters — the eval scores what was *stored*, not what the model said, so
 * confidence thresholding, restricted masking and credential dedupe are all in
 * scope.
 */
export async function runCase(handle: PipelineHandle, c: ExtractionCase): Promise<CaseOutcome> {
  handle.toolsCalled.length = 0;
  const empty: CaseOutcome = {
    caseId: c.id,
    ok: false,
    toolsCalled: [],
    documentKind: null,
    fields: [],
    credentials: [],
    restrictedFields: [],
    policyAfter: { ...handle.policy },
  };

  try {
    const ingested = (await handle.callTool('documents_ingest', { path: c.path })) as { document_id: string };
    const extracted = (await handle.callTool('documents_extract', { document_id: ingested.document_id })) as ExtractResult;
    const provider = (await handle.callTool('providers_get', { provider_id: extracted.provider_id })) as ProviderResult;
    return {
      caseId: c.id,
      ok: true,
      toolsCalled: [...handle.toolsCalled],
      documentKind: extracted.document_kind,
      fields: normalizeMasking(provider.fields),
      credentials: provider.credentials,
      restrictedFields: [...extracted.restricted_fields].sort(),
      policyAfter: { ...handle.policy },
    };
  } catch (err) {
    return { ...empty, toolsCalled: [...handle.toolsCalled], error: err instanceof Error ? err.message : String(err) };
  }
}
