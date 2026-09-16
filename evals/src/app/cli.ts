import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayFromEnv } from '@harness/core-tools';
import { optionalEnv } from '@harness/shared';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { runEvals } from '../domain/orchestrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// evals/src/app -> the repository root
const repoRoot = path.resolve(here, '../../..');

function flagFrom(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function flag(name: string): string | undefined {
  return flagFrom(process.argv, name);
}

export type LimitFlagResult = { ok: true; limit: number | undefined } | { ok: false; error: string };

/**
 * `--limit=N` must be a positive integer. `Number(flag)` alone lets `NaN`
 * (from an empty, non-numeric, or missing value) through as a defined
 * `RunOptions.limit`, and `selectCases` treats a `NaN` limit as "keep
 * shrinking the picked list forever" only by accident of `picked.length <
 * limit` being false for a `NaN` bound in one direction and true in the
 * other — in practice it silently selects zero cases, so the run scores
 * nothing and still exits 0. A bad `--limit` must fail loudly instead.
 *
 * Pure and exported so a test can check every input without spawning the CLI;
 * the CLI entry point below turns `{ ok: false }` into `exit 2`.
 */
export function parseLimitFlag(argv: readonly string[]): LimitFlagResult {
  const raw = flagFrom(argv, 'limit');
  if (raw === undefined) return { ok: true, limit: undefined };
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { ok: false, error: `--limit must be a positive integer, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, limit: Number(raw) };
}

export type UpdateBaselineFlagResult = { ok: true; update: boolean } | { ok: false; error: string };

/**
 * `--update-baseline` and `--update-baseline=true` both mean "write the
 * report as the new baseline"; `--update-baseline=false` means "do not".
 * Any other value is a usage error rather than a silent no-op, because a
 * typo here would quietly leave the old baseline in place.
 */
export function parseUpdateBaselineFlag(argv: readonly string[]): UpdateBaselineFlagResult {
  if (argv.includes('--update-baseline')) return { ok: true, update: true };
  const raw = flagFrom(argv, 'update-baseline');
  if (raw === undefined || raw === 'false') return { ok: true, update: false };
  if (raw === 'true') return { ok: true, update: true };
  return { ok: false, error: `--update-baseline takes no value, true or false, got ${JSON.stringify(raw)}` };
}

/**
 * CLI usage: `pnpm --filter @harness/evals start -- [flags]`
 *
 *   --corpus=<dir>      Corpus root. Defaults to packs/healthcare/synthetic/out.
 *   --cases=<file>      Extraction cases file. Defaults to <corpus>/cases.jsonl.
 *   --injection=<file>  Injection cases file. Defaults to the pack's declared
 *                        `evals.injectionFile` (packs/healthcare/evals/injection.jsonl today).
 *   --out=<dir>         Where report.json and report.md are written. Defaults to evals/results.
 *   --baseline=<file>   Baseline report to compare against. Defaults to evals/baseline.json.
 *   --version=<string>  Recorded as eval_set_version. Defaults to 1.0.0.
 *   --limit=<N>         Positive integer. Run a sample of N cases instead of the whole corpus
 *                        (see selectCases). Anything else is a usage error: exit 2, nothing run.
 *   --gateway=<url>     Override the gateway's base URL only. The key still comes from
 *                        LITELLM_MASTER_KEY via gatewayFromEnv() -- this never takes a key on
 *                        the command line.
 *   --update-baseline   After scoring, write the report to the --baseline path (default
 *                        evals/baseline.json). `=true` is accepted too; `=false` is a no-op.
 */
// Guarded, not bare: `cli.test.ts` imports the two flag parsers above, and an
// unguarded entrypoint would run a whole eval the moment that import resolved.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Validate CLI-only flags before anything that touches the environment or a
  // network, so a usage error exits 2 with no cases run and no gateway or
  // database required, rather than failing later for an unrelated reason.
  const limitFlag = parseLimitFlag(process.argv);
  if (!limitFlag.ok) {
    process.stderr.write(`${limitFlag.error}\n`);
    process.exit(2);
  }
  const updateBaselineFlag = parseUpdateBaselineFlag(process.argv);
  if (!updateBaselineFlag.ok) {
    process.stderr.write(`${updateBaselineFlag.error}\n`);
    process.exit(2);
  }

  // CLI only, like `@harness/db`'s migrate: a test that imports `runEvals` must
  // not pick up the developer's repository-root .env.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

  const corpusDir = path.resolve(flag('corpus') ?? path.join(repoRoot, 'packs/healthcare/synthetic/out'));
  const gateway = gatewayFromEnv();
  // `--gateway` overrides only the proxy's base URL, for pointing a run at a
  // gateway other than `HARNESS_GATEWAY_URL` (a staging proxy, a fake one in
  // an ad hoc smoke test). The key still comes from the environment: a
  // gateway address is not a secret and belongs on the command line, but
  // `LITELLM_MASTER_KEY` does not.
  const gatewayOverride = flag('gateway');
  if (gatewayOverride) gateway.baseUrl = gatewayOverride.replace(/\/+$/, '');
  const routing = JSON.parse(optionalEnv('EVALS_SERVING_MODEL') ?? '{}') as Record<string, string>;
  const limit = limitFlag.limit;
  const baselineFile = path.resolve(flag('baseline') ?? path.join(repoRoot, 'evals/baseline.json'));

  const { report, markdown, exitCode } = await runEvals({
    corpusDir,
    casesFile: flag('cases') ?? path.join(corpusDir, 'cases.jsonl'),
    injectionFile: flag('injection') ?? healthcarePack.evals?.injectionFile ?? path.join(corpusDir, 'injection.jsonl'),
    outDir: path.resolve(flag('out') ?? path.join(repoRoot, 'evals/results')),
    baselineFile,
    databaseUrl: optionalEnv('EVALS_DATABASE_URL') ?? 'postgres://harness:harness@localhost:15432/harness_evals',
    gateway,
    judgeDeps: null,
    servingModel:
      Object.keys(routing).length > 0
        ? routing
        : { extract: 'see clients/<name>/routing.yaml', judge: 'see clients/<name>/routing.yaml' },
    evalSetVersion: flag('version') ?? '1.0.0',
    limit,
  });

  process.stdout.write(`${markdown}\n`);
  if (updateBaselineFlag.update) {
    await writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write('baseline updated\n');
  }
  process.exit(exitCode);
}
