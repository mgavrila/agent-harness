import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_POLICY,
  MASKED,
  PACK_KERNEL,
  createCoreToolsServer,
  loadPacks,
  type GatewayConfig,
  type PackRegistry,
  type Policy,
  type ToolDeps,
} from '@harness/core-tools';
import { connectInProcess } from '@harness/core-tools/in-process';
import { createDb, runMigrations, type Db } from '@harness/db';
import { resetDatabase } from '@harness/db/testing';
import { ConfigError, describeError } from '@harness/shared';
import type { ExtractionCase } from './cases.js';
import type { CaseOutcome, StoredAttachment, StoredField } from './score.js';

/**
 * The environment every eval hands a pack, before the packs add their own.
 *
 * Empty, and that is the point. The runner has no opinion about which variables a pack's tools
 * read: it used to name one pack's four by hand, which is a measuring instrument knowing an area
 * of the product. A pack declares its own pins as `evals.testEnv` and `evalPackEnv` merges every
 * loaded pack's over this base.
 *
 * Exported so `judge-deps.test-helpers.ts` starts from the same base: the judge is a second
 * caller of the same tools, and giving it a looser environment than the pipeline would measure a
 * configuration nothing ships.
 */
export const EVAL_PACK_ENV: Readonly<Record<string, string>> = {};

/** The base map plus every loaded pack's `evals.testEnv`, in load order. */
export function evalPackEnv(packs: PackRegistry): Readonly<Record<string, string>> {
  return Object.assign({}, EVAL_PACK_ENV, ...packs.all.map((p) => p.evals?.testEnv ?? {})) as Record<string, string>;
}

export interface PipelineHandle {
  /** Calls a tool and records its name. Throws on an error envelope. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Every tool name called since the last reset, in order. */
  toolsCalled: string[];
  policy: Policy;
  /** The threshold the tools under test applied, so the scorers assert on the same number. */
  confidenceThreshold: number;
  /** Every loaded pack, so a caller can see the deployment this handle opened. */
  packs: PackRegistry;
  /** The pack being measured, by `Pack.name`. */
  measured: string;
  /** Which tools `runCase` drives and which keys it reads, resolved for this deployment. */
  tools: PipelineTools;
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
   * Packs to load, as `HARNESS_PACKS` would name them, first one first. Not defaulted: the eval
   * runner has no opinion about which pack it measures, and a default here would be one — the
   * caller that knows is the CLI, which reads `HARNESS_PACKS`. Give this or `registry`.
   */
  packs?: readonly string[];
  /**
   * An already-built registry, in place of `packs`.
   *
   * `loadPacks` reaches a pack by dynamic `import()` of its package name, so it can only load a
   * pack that is published as a package. A test that needs a second pack beside healthcare
   * builds one with `definePack` and hands it over here through `registryOf`. Nothing that
   * ships passes this: the CLI names packs, exactly as a server does.
   */
  registry?: PackRegistry;
  /**
   * Which loaded pack is being measured, by `Pack.name`. Its `evals.readback` decides the tools
   * `runCase` drives, and its `formsDir` is the one the tools under test see. Defaults to the
   * first loaded pack, which is the whole answer for a single-pack run.
   */
  measured?: string;
}

/**
 * Which tools one case drives and which keys it reads, resolved against a live deployment.
 *
 * `EvalReadback` is what a pack *declares*; this is what that declaration resolves to once the
 * loaded packs are known. The two differ in one place, and it is the reason this type exists
 * separately: `Pack.replaces` is process-wide, so the pack that publishes `documents_extract`
 * need not be the pack being measured. The measured pack says which tools to call; whoever
 * publishes the extract tool decides which key its result carries.
 */
export interface PipelineTools {
  ingestTool: string;
  extractTool: string;
  readTool: string;
  /** The key `extractTool`'s result carries the new record's id under. */
  extractIdKey: string;
  /** The argument name `readTool` takes that id under. */
  readIdKey: string;
  /** The key `readTool`'s result carries the attachment list under. */
  attachmentsKey: string;
}

/** The kernel's own names, which every member of `EvalReadback` defaults to. */
export const KERNEL_PIPELINE_TOOLS: PipelineTools = {
  ingestTool: 'documents_ingest',
  extractTool: 'documents_extract',
  readTool: 'records_get',
  extractIdKey: 'record_id',
  readIdKey: 'record_id',
  attachmentsKey: 'attachments',
};

/**
 * What `runCase` calls, for one measured pack in one deployment.
 *
 * The measured pack's `evals.readback` names every tool and both keys, each falling back to the
 * kernel's. The one thing it cannot answer for is the key the *extract result* carries: a pack
 * loaded beside it may have replaced `documents_extract` under the same name and may answer in
 * its own vocabulary — a shipped pack does exactly that, renaming the new record's id — and a
 * second measured pack declaring the kernel's `record_id` used to read `undefined` off it and
 * failed every case. So that one key is read off whichever loaded pack `replaces` the extract
 * tool, and only then off the measured pack's own declaration.
 *
 * A pack that replaces the extract tool and declares no `evals.readback` of its own is taken at
 * the kernel's word. There is nothing else to go on, and the alternative — guessing from the
 * result's shape — is what this whole block exists to stop.
 */
export function resolvePipelineTools(packs: PackRegistry, measured: string): PipelineTools {
  const readback = packs.byName(measured).evals?.readback ?? {};
  const extractTool = readback.extractTool ?? KERNEL_PIPELINE_TOOLS.extractTool;
  const publisher = packs.all.find((p) => (p.replaces ?? []).includes(extractTool));
  return {
    ingestTool: readback.ingestTool ?? KERNEL_PIPELINE_TOOLS.ingestTool,
    extractTool,
    readTool: readback.readTool ?? KERNEL_PIPELINE_TOOLS.readTool,
    extractIdKey: publisher?.evals?.readback?.recordIdKey ?? KERNEL_PIPELINE_TOOLS.extractIdKey,
    readIdKey: readback.recordIdKey ?? KERNEL_PIPELINE_TOOLS.readIdKey,
    attachmentsKey: readback.attachmentsKey ?? KERNEL_PIPELINE_TOOLS.attachmentsKey,
  };
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
  if (!opts.registry && !opts.packs) {
    throw new ConfigError('openPipeline needs either `packs` to load or an already-built `registry`');
  }
  const packs = opts.registry ?? (await loadPacks([...(opts.packs ?? [])]));
  // `byName` throws a ConfigError naming the pack, which is the message the caller wants; for the
  // default it cannot throw, because `registryOf` refuses an empty registry.
  const measuredPack = packs.byName(opts.measured ?? packs.all[0].name);
  const tools = resolvePipelineTools(packs, measuredPack.name);

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
    // The pipeline under test reads documents; it fills no forms. The measured pack's shipped
    // templates directory is still the honest value: a tool that did reach for one would find
    // what a deployment finds, not a stub. The measured pack's, not the first loaded one's —
    // when two packs are loaded, the run measures one of them and it is not always the first.
    // A pack that ships no forms directory is legal, and the pipeline fills no forms either way.
    formsDir: measuredPack.formsDir ?? opts.storageDir,
    restrictedToModel: false,
    sinks: {},
    context: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    // A fixed map, never the ambient environment. The eval runs on whatever machine happens to
    // have a database, and a shipped `.env` there may well switch an outbound lookup on and
    // point it at a live endpoint — so a pack reading the ambient environment would have this
    // suite making real outbound calls. What to pin is each pack's own declaration.
    env: evalPackEnv(packs),
  };

  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));

  return {
    toolsCalled,
    policy,
    confidenceThreshold,
    packs,
    measured: measuredPack.name,
    tools,
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

/**
 * One case: ingest the document, extract it, then read the record back. The read matters — the
 * eval scores what was *stored*, not what the model said, so confidence thresholding, restricted
 * masking and attachment dedupe are all in scope.
 *
 * Not one tool name here is a literal. All three come off `handle.tools`, which `openPipeline`
 * resolved from the measured pack's `evals.readback` against the packs it loaded: a pack that
 * renames the read gets its own name and its own id key, and a pack that ships no tools of its
 * own gets the kernel's `records_get` and `record_id`.
 */
export async function runCase(handle: PipelineHandle, c: ExtractionCase): Promise<CaseOutcome> {
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

  const tools = handle.tools;
  try {
    const ingested = (await handle.callTool(tools.ingestTool, { path: c.path })) as { document_id: string };
    const extracted = (await handle.callTool(tools.extractTool, {
      document_id: ingested.document_id,
    })) as Record<string, unknown> & { document_kind: string; restricted_fields: string[] };
    const recordId = extracted[tools.extractIdKey] as string;
    const stored = (await handle.callTool(tools.readTool, { [tools.readIdKey]: recordId })) as Record<
      string,
      unknown
    > & { fields: StoredField[] };
    return {
      caseId: c.id,
      ok: true,
      toolsCalled: [...handle.toolsCalled],
      documentKind: extracted.document_kind,
      fields: normalizeMasking(stored.fields),
      attachments: (stored[tools.attachmentsKey] ?? []) as StoredAttachment[],
      restrictedFields: [...extracted.restricted_fields].sort(),
      policyAfter: { ...handle.policy },
    };
  } catch (err) {
    return { ...empty, toolsCalled: [...handle.toolsCalled], error: describeError(err) };
  }
}
