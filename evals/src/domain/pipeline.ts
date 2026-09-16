import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_POLICY,
  MASKED,
  PACK_KERNEL,
  createCoreToolsServer,
  loadPacks,
  type GatewayConfig,
  type Policy,
  type ToolDeps,
} from '@harness/core-tools';
import { connectInProcess } from '@harness/core-tools/in-process';
import { createDb, runMigrations, type Db } from '@harness/db';
import { resetDatabase } from '@harness/db/testing';
import type { EvalReadback } from '@harness/pack-api';
import { describeError } from '@harness/shared';
import type { ExtractionCase } from './cases.js';
import type { CaseOutcome, StoredAttachment, StoredField } from './score.js';

/**
 * The environment every eval hands a pack, in place of the process's own.
 *
 * Exported so `judge-deps.test-helpers.ts` pins the same thing: the judge is a second caller of
 * the same tools, and giving it a looser environment than the pipeline would measure a
 * configuration nothing ships.
 */
export const EVAL_PACK_ENV: Readonly<Record<string, string>> = {
  VERIFY_NPPES_ENABLED: 'false',
  NPPES_BASE_URL: 'http://127.0.0.1:1/api/',
  VERIFY_STATE_LICENSE_ENABLED: 'false',
  VERIFY_TIMEOUT_MS: '5000',
};

export interface PipelineHandle {
  /** Calls a tool and records its name. Throws on an error envelope. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Every tool name called since the last reset, in order. */
  toolsCalled: string[];
  policy: Policy;
  /** The threshold the tools under test applied, so the scorers assert on the same number. */
  confidenceThreshold: number;
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
  /** Defaults to the shipped threshold. Set it to measure a different one. */
  confidenceThreshold?: number;
  /**
   * Packs to load, as `HARNESS_PACKS` would name them, first one first. Required and not
   * defaulted: the eval runner has no opinion about which pack it measures, and a default here
   * would be one — the caller that knows is the CLI, which reads `HARNESS_PACKS`.
   */
  packs: readonly string[];
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
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const toolsCalled: string[] = [];
  const packs = await loadPacks([...opts.packs]);

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
    confidenceThreshold,
    gateway: opts.gateway,
    storageDir: opts.storageDir,
    // The pipeline under test reads documents; it fills no forms. The shipped
    // templates directory is still the honest value: a tool that did reach for
    // one would find what a deployment finds, not a stub. A pack that ships no
    // forms directory is legal, and the pipeline fills no forms either way.
    formsDir: packs.all[0].formsDir ?? opts.storageDir,
    restrictedToModel: false,
    sinks: {},
    context: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    // A fixed map, never the ambient environment. The eval runs on whatever machine happens to
    // have a database, and the shipped `.env` carries `VERIFY_NPPES_ENABLED=true` and the live
    // CMS endpoint — so a pack reading the ambient environment would have this suite making
    // real outbound registry lookups. The flag is off and the endpoint is a port nothing
    // listens on, which is the pin `ToolDeps.verify` used to carry before the pack owned it.
    env: EVAL_PACK_ENV,
  };

  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));

  return {
    toolsCalled,
    policy,
    confidenceThreshold,
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

/**
 * The pack's readback tool masks a restricted field with the `MASKED` sentinel string,
 * never the plaintext, but the eval's own contract is `null` for a masked
 * field — see `StoredField.value`. Normalize only that exact sentinel to
 * `null`; anything else stays untouched, restricted or not, so a real
 * plaintext leak through that tool still reads as non-null and still
 * fails `scoreInjection`'s `restricted_fields_still_redacted` check instead
 * of being silently swallowed here.
 */
export function normalizeMasking(fields: StoredField[]): StoredField[] {
  return fields.map((f) => (f.value === MASKED ? { ...f, value: null } : f));
}

/** The kernel's own three. A pack that ships no tools of its own needs no `readback` block. */
export const DEFAULT_READBACK: EvalReadback = {
  tool: 'records_get',
  recordIdKey: 'record_id',
  attachmentsKey: 'attachments',
};

/**
 * One case: ingest the document, extract it, then read the record back. The read matters — the
 * eval scores what was *stored*, not what the model said, so confidence thresholding, restricted
 * masking and attachment dedupe are all in scope.
 *
 * The three tool names come from the pack: healthcare renames the readback to `providers_get`
 * and carries the record id as `provider_id`, a pack that ships no tools uses the kernel's.
 */
export async function runCase(
  handle: PipelineHandle,
  c: ExtractionCase,
  readback: EvalReadback = DEFAULT_READBACK,
): Promise<CaseOutcome> {
  handle.toolsCalled.length = 0;
  const empty: CaseOutcome = {
    caseId: c.id,
    ok: false,
    toolsCalled: [],
    documentKind: null,
    fields: [],
    attachments: [],
    restrictedFields: [],
    policyAfter: { ...handle.policy },
  };

  try {
    const ingested = (await handle.callTool('documents_ingest', { path: c.path })) as { document_id: string };
    const extracted = (await handle.callTool('documents_extract', {
      document_id: ingested.document_id,
    })) as Record<string, unknown> & { document_kind: string; restricted_fields: string[] };
    const recordId = extracted[readback.recordIdKey] as string;
    const stored = (await handle.callTool(readback.tool, { [readback.recordIdKey]: recordId })) as Record<
      string,
      unknown
    > & { fields: StoredField[] };
    return {
      caseId: c.id,
      ok: true,
      toolsCalled: [...handle.toolsCalled],
      documentKind: extracted.document_kind,
      fields: normalizeMasking(stored.fields),
      attachments: (stored[readback.attachmentsKey] ?? []) as StoredAttachment[],
      restrictedFields: [...extracted.restricted_fields].sort(),
      policyAfter: { ...handle.policy },
    };
  } catch (err) {
    return { ...empty, toolsCalled: [...handle.toolsCalled], error: describeError(err) };
  }
}
