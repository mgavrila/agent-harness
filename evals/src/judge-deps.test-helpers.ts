/**
 * A `ToolDeps` for the judge, for the two suites that call `judgeFreeText`
 * directly: its own test, and the orchestrator test that threads one through
 * `runEvals`.
 *
 * Both used to build the same twenty-line bag by hand, differing only in the
 * storage directory. It mirrors what `openPipeline` builds for the pipeline
 * under test — same client, same off-by-default verification, same empty sink
 * registry — because the judge is a second caller of the same tools and giving
 * it looser deps than the pipeline would measure a configuration nothing ships.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and
 * the "no test imported by production" architecture rule matches on the name.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_POLICY, PACK_KERNEL, clientDirFor, localParser, registryOf, type ToolDeps } from '@harness/core-tools';
import { createDb } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { EVALS_DATABASE_URL } from './corpus.test-helpers.js';
import { evalPackEnv } from './domain/pipeline.js';

const packs = registryOf([healthcarePack]);

export interface JudgeHarness {
  deps: ToolDeps;
  /** Closes the pool this opened. Call it in `afterAll`. */
  close: () => Promise<void>;
}

/**
 * Open a judge against `gatewayUrl`. `storageDir` is where the judge would
 * resolve a path if it ever reached for one; it never does, so any directory
 * inside the test's own tree will do.
 */
export function openJudgeDeps(opts: { gatewayUrl: string; storageDir: string }): JudgeHarness {
  const { db, close } = createDb(EVALS_DATABASE_URL);
  return {
    close,
    deps: {
      db,
      client: 'evals',
      principal: {
        id: 'svc-judge',
        kind: 'service',
        level: 'service',
        displayName: 'Eval judge',
        surfaces: {},
        attributes: {},
      },
      policy: { ...DEFAULT_POLICY },
      // Ephemeral: the eval database is truncated between cases, so nothing
      // encrypted under this key has to be readable later.
      encryptionKey: randomBytes(32),
      now: () => new Date(),
      approvalTtlHours: 24,
      confidenceThreshold: 0.85,
      gateway: { baseUrl: opts.gatewayUrl, apiKey: 'sk-eval', timeoutMs: 10_000, maxCallsPerRun: 100 },
      storageDir: opts.storageDir,
      // The judge reaches for neither, and gets the pipeline's own values rather than a stub.
      clientDir: clientDirFor('evals'),
      embedDims: 1_024,
      parser: localParser(opts.storageDir),
      formsDir: packs.all[0]?.formsDir ?? opts.storageDir,
      restrictedToModel: false,
      sinks: {},
      context: { runId: null, threadId: null, surface: null, conversation: null },
      tools: new Map(),
      kernelTools: new Map(),
      kernel: PACK_KERNEL,
      packs,
      // The pipeline's pins, resolved the same way rather than copied: every loaded pack's own.
      env: evalPackEnv(packs),
    },
  };
}
