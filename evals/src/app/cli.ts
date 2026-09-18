import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayFromEnv, loadPacks, type Pack } from '@harness/core-tools';
import { describeError, optionalEnv } from '@harness/shared';
import { runEvals } from '../domain/orchestrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// evals/src/app -> the repository root
const repoRoot = path.resolve(here, '../../..');

/**
 * `--name=value`, or `undefined`. Exported so `cli.test.ts` can check a flag's parsing without
 * a database or a gateway; the flags with rules of their own get a parser each below.
 */
export function flagFrom(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/**
 * Which packs this run loads.
 *
 * `HARNESS_PACKS` names them, exactly as it does for a server; `--pack` picks one of them when
 * several are. Unset, the default is the shipped pack, so a single-pack deployment needs neither
 * flag nor variable and behaves as it always did. Set to the empty string it names no pack, which
 * a server serves happily and an eval run cannot: `runEvals` refuses it below, because a run with
 * nothing to measure has no report to write.
 */
export function packNames(env: string | undefined): string[] {
  return (env ?? '@harness/pack-healthcare')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * The packs this run loads, or the usage error that stops it.
 *
 * The same `{ ok }` shape as the flag parsers above, and for the same reason: the check is worth
 * a test of its own, and the entrypoint below is a guarded `import.meta` block no test can call.
 * A server may serve no pack; a run that measures one may not, and it says so before `loadPacks`
 * logs that it loaded none.
 */
export function packsToMeasure(env: string | undefined): { ok: true; names: string[] } | { ok: false; error: string } {
  const names = packNames(env);
  if (names.length === 0) {
    return { ok: false, error: 'HARNESS_PACKS names no pack; an eval run measures one, so name it there' };
  }
  return { ok: true, names };
}

function flag(name: string): string | undefined {
  return flagFrom(process.argv, name);
}

type PackFlagResult = { ok: true; pack: string | undefined } | { ok: false; error: string };

/**
 * `--pack=<name>` or `--pack <name>`, both spellings, or `undefined` when neither is given.
 *
 * The spec writes the flag space-separated and the first implementation read only the `=` form,
 * so `--pack stories` silently measured the first pack `HARNESS_PACKS` named and wrote a report
 * headed with the wrong pack's name. A missing value is a usage error for the same reason: a
 * bare `--pack`, or one followed by another flag, is somebody asking for a pack they did not
 * manage to name, and falling back to the first one answers a question they did not ask.
 *
 * An unknown name is a usage error too, but not here: only the loaded registry knows which names
 * exist, so the entry point below turns `byName`'s `ConfigError` into the same exit 2.
 */
export function parsePackFlag(argv: readonly string[]): PackFlagResult {
  const missing = { ok: false, error: '--pack needs the name of a loaded pack, e.g. --pack=stories' } as const;
  const joined = flagFrom(argv, 'pack');
  if (joined !== undefined) return joined.trim() === '' ? missing : { ok: true, pack: joined.trim() };
  const at = argv.indexOf('--pack');
  if (at === -1) return { ok: true, pack: undefined };
  const next = argv[at + 1];
  // A pack name is lowercase letters, digits and hyphens and never opens with one, so a leading
  // dash is the next flag, not this flag's value.
  if (next === undefined || next.startsWith('-') || next.trim() === '') return missing;
  return { ok: true, pack: next.trim() };
}

type LimitFlagResult = { ok: true; limit: number | undefined } | { ok: false; error: string };

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

type UpdateBaselineFlagResult = { ok: true; update: boolean } | { ok: false; error: string };

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
 *   --pack=<name>       Which loaded pack to measure, by Pack.name. `--pack <name>` is accepted
 *                        too. Defaults to the first one HARNESS_PACKS names; a bare --pack, or a
 *                        name no loaded pack answers to, is a usage error: exit 2, nothing run.
 *                        Every path below defaults to that pack's evals block.
 *   --corpus=<dir>      Corpus root. Defaults to the pack's `evals.corpusDir`.
 *   --cases=<file>      Extraction cases file. Defaults to the pack's `evals.casesFile`.
 *   --injection=<file>  Injection cases file. Defaults to the pack's declared
 *                        `evals.injectionFile`, then to <corpus>/injection.jsonl.
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
  const packFlag = parsePackFlag(process.argv);
  if (!packFlag.ok) {
    process.stderr.write(`${packFlag.error}\n`);
    process.exit(2);
  }

  // CLI only, like `@harness/db`'s migrate: a test that imports `runEvals` must
  // not pick up the developer's repository-root .env.
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

  // Everything the run measures comes off the loaded pack, which is what makes this runner
  // pack-agnostic: it imports none, and `HARNESS_PACKS` names what it loads.
  // Read raw rather than through `optionalEnv`, which cannot tell an unset variable from an empty
  // one — and here they mean different things: the shipped pack, or no pack at all.
  const toMeasure = packsToMeasure(process.env.HARNESS_PACKS);
  if (!toMeasure.ok) {
    process.stderr.write(`${toMeasure.error}\n`);
    process.exit(2);
  }
  const registry = await loadPacks(toMeasure.names);
  const wanted = packFlag.pack;
  let measured: Pack;
  try {
    measured = wanted === undefined ? registry.all[0] : registry.byName(wanted);
  } catch (err) {
    // `byName` throws a ConfigError naming the pack, which is the message an operator wants.
    // Prefixed with the flag and exited 2, so an unknown --pack reads as the usage error it is
    // rather than as a crash.
    process.stderr.write(`--pack: ${describeError(err)}\n`);
    process.exit(2);
  }
  const evals = measured.evals;
  if (!evals) {
    process.stderr.write(`pack "${measured.name}" declares no evals block; there is nothing to measure\n`);
    process.exit(2);
  }

  const corpusDir = path.resolve(flag('corpus') ?? evals.corpusDir ?? path.dirname(evals.casesFile));
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
    casesFile: flag('cases') ?? evals.casesFile,
    injectionFile: flag('injection') ?? evals.injectionFile ?? path.join(corpusDir, 'injection.jsonl'),
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
    packs: toMeasure.names,
    packName: measured.name,
    recordKinds: measured.records.map((r) => r.kind),
    judgedFields: evals.judgedFields,
    intakeSkillFile: evals.intakeSkill,
  });

  process.stdout.write(`${markdown}\n`);
  if (updateBaselineFlag.update) {
    await writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write('baseline updated\n');
  }
  process.exit(exitCode);
}
