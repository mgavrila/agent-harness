import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeGateway, type FakeGateway } from '@harness/core-tools/fake-gateway';
import { EVALS_DATABASE_URL, EXTRACTION, VERDICTS, writeEvalCorpus } from '../corpus.test-helpers.js';
import type { Report } from '../domain/report/types.js';
import { flagFrom, packNames, parseLimitFlag, parsePackFlag, parseUpdateBaselineFlag } from './cli.js';

const execFileAsync = promisify(execFile);
const evalsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxBin = path.join(evalsDir, 'node_modules', '.bin', 'tsx');
const runScript = path.join(evalsDir, 'src', 'app', 'cli.ts');

let dir: string;
let corpus: string;
let casesFile: string;
let injectionFile: string;
let gateway: FakeGateway;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-cli-'));
  ({ corpusDir: corpus, casesFile, injectionFile } = await writeEvalCorpus(dir));
  gateway = await startFakeGateway((call) => ({ content: call.model === 'judge' ? VERDICTS : EXTRACTION }));
}, 120_000);

afterAll(async () => {
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
});

describe('--pack', () => {
  it('reads the flag when it is given and leaves it undefined when it is not', () => {
    // Undefined means "measure the first pack HARNESS_PACKS names", which is what a single-pack
    // deployment gets without flag or variable.
    expect(flagFrom(['node', 'cli.ts'], 'pack')).toBeUndefined();
    expect(flagFrom(['node', 'cli.ts', '--pack=stories'], 'pack')).toBe('stories');
    expect(flagFrom(['node', 'cli.ts', '--pack=healthcare', '--limit=3'], 'pack')).toBe('healthcare');
  });
});

describe('parsePackFlag', () => {
  it('reads both spellings, and no flag still means the first loaded pack', () => {
    expect(parsePackFlag(['node', 'cli.ts'])).toEqual({ ok: true, pack: undefined });
    expect(parsePackFlag(['node', 'cli.ts', '--pack=stories'])).toEqual({ ok: true, pack: 'stories' });
    // The spec writes the flag this way, and reading only the `=` form measured the first pack
    // and headed the report with its name.
    expect(parsePackFlag(['node', 'cli.ts', '--pack', 'stories'])).toEqual({ ok: true, pack: 'stories' });
    expect(parsePackFlag(['node', 'cli.ts', '--pack', 'stories', '--limit=3'])).toEqual({
      ok: true,
      pack: 'stories',
    });
    expect(parsePackFlag(['node', 'cli.ts', '--limit=3', '--pack=healthcare'])).toEqual({
      ok: true,
      pack: 'healthcare',
    });
  });

  // Falling back to the first loaded pack here answers a question the operator did not ask, and
  // the report it writes names a pack they did not choose.
  for (const argv of [['--pack'], ['--pack', '--limit=3'], ['--pack='], ['--pack', '  ']]) {
    it(`rejects ${JSON.stringify(argv)} as a --pack with no name`, () => {
      const result = parsePackFlag(['node', 'cli.ts', ...argv]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('--pack needs the name of a loaded pack');
    });
  }
});

describe('packNames', () => {
  it('splits HARNESS_PACKS, trims it, and falls back to the shipped pack', () => {
    expect(packNames(undefined)).toEqual(['@harness/pack-healthcare']);
    expect(packNames('@harness/pack-healthcare')).toEqual(['@harness/pack-healthcare']);
    expect(packNames(' @harness/pack-healthcare , @harness/pack-stories ')).toEqual([
      '@harness/pack-healthcare',
      '@harness/pack-stories',
    ]);
    // A trailing comma is a typo, not a request to load a pack with no name.
    expect(packNames('@harness/pack-healthcare,')).toEqual(['@harness/pack-healthcare']);
  });
});

describe('parseUpdateBaselineFlag', () => {
  it('accepts the bare flag and =true, treats absence and =false as no-op', () => {
    expect(parseUpdateBaselineFlag(['node', 'run.ts'])).toEqual({ ok: true, update: false });
    expect(parseUpdateBaselineFlag(['node', 'run.ts', '--update-baseline'])).toEqual({ ok: true, update: true });
    expect(parseUpdateBaselineFlag(['node', 'run.ts', '--update-baseline=true'])).toEqual({ ok: true, update: true });
    expect(parseUpdateBaselineFlag(['node', 'run.ts', '--update-baseline=false'])).toEqual({ ok: true, update: false });
  });

  it('rejects any other value instead of silently ignoring it', () => {
    for (const bad of ['yes', '1', '', 'TRUE']) {
      const result = parseUpdateBaselineFlag(['node', 'run.ts', `--update-baseline=${bad}`]);
      expect(result.ok).toBe(false);
    }
  });
});

describe('parseLimitFlag', () => {
  it('returns undefined when --limit is not given', () => {
    expect(parseLimitFlag(['node', 'run.ts'])).toEqual({ ok: true, limit: undefined });
  });

  it('accepts a positive integer', () => {
    expect(parseLimitFlag(['--limit=24'])).toEqual({ ok: true, limit: 24 });
    expect(parseLimitFlag(['--limit=1'])).toEqual({ ok: true, limit: 1 });
  });

  // `Number('')`, `Number('  ')` and `Number(null)` are all `0` or `NaN`-adjacent
  // surprises; `selectCases` treats an unguarded NaN/0 limit as "pick nothing",
  // which used to make a typo'd --limit exit 0 having scored zero cases.
  for (const bad of ['0', '-3', '3.5', 'abc', '', ' ', '1e3', '024', 'NaN', 'Infinity']) {
    it(`rejects ${JSON.stringify(bad)} as not a positive integer`, () => {
      const result = parseLimitFlag([`--limit=${bad}`]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('--limit must be a positive integer');
    });
  }
});

describe('CLI', () => {
  it('exits 2 on an invalid --limit and runs no cases', async () => {
    const outDir = path.join(dir, 'cli-bad-limit-out');
    await expect(
      execFileAsync(
        tsxBin,
        [
          runScript,
          '--limit=abc',
          `--out=${outDir}`,
          `--cases=${casesFile}`,
          `--corpus=${corpus}`,
          `--injection=${injectionFile}`,
          `--baseline=${path.join(dir, 'no-such-baseline.json')}`,
        ],
        {
          cwd: evalsDir,
          env: {
            ...process.env,
            // Deliberately absent/invalid gateway credentials: a bad --limit
            // must be rejected before any of this is touched.
            LITELLM_MASTER_KEY: '',
            HARNESS_GATEWAY_URL: '',
            EVALS_DATABASE_URL,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--limit must be a positive integer') });

    await expect(readFile(path.join(outDir, 'report.json'), 'utf8')).rejects.toThrow();
  }, 60_000);

  it('exits 2 naming the flag when --pack does not match a loaded pack', async () => {
    // Resolved before the gateway or the database is touched, like the other usage errors: an
    // operator who mistypes the pack gets the flag back, not a connection failure.
    await expect(
      execFileAsync(tsxBin, [runScript, '--pack=no-such-pack', `--out=${path.join(dir, 'cli-bad-pack-out')}`], {
        cwd: evalsDir,
        env: { ...process.env, LITELLM_MASTER_KEY: '', HARNESS_GATEWAY_URL: '', EVALS_DATABASE_URL },
      }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--pack') });
  }, 60_000);

  it('exits 2 when --pack is given no name, before the gateway or the database is touched', async () => {
    await expect(
      execFileAsync(tsxBin, [runScript, '--pack', `--out=${path.join(dir, 'cli-nameless-pack-out')}`], {
        cwd: evalsDir,
        env: { ...process.env, LITELLM_MASTER_KEY: '', HARNESS_GATEWAY_URL: '', EVALS_DATABASE_URL },
      }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--pack needs the name of a loaded pack') });
  }, 60_000);

  it('exits 2 naming the flag when the space-separated --pack does not match a loaded pack', async () => {
    await expect(
      execFileAsync(tsxBin, [runScript, '--pack', 'no-such-pack', `--out=${path.join(dir, 'cli-bad-pack2-out')}`], {
        cwd: evalsDir,
        env: { ...process.env, LITELLM_MASTER_KEY: '', HARNESS_GATEWAY_URL: '', EVALS_DATABASE_URL },
      }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('no pack named "no-such-pack"') });
  }, 60_000);

  it('writes the new baseline to the --baseline path when --update-baseline is given bare', async () => {
    const outDir = path.join(dir, 'cli-update-baseline-out');
    const baselineFile = path.join(dir, 'cli-custom-baseline.json');
    await execFileAsync(
      tsxBin,
      [
        runScript,
        `--gateway=${gateway.url}`,
        `--out=${outDir}`,
        `--cases=${casesFile}`,
        `--corpus=${corpus}`,
        `--injection=${injectionFile}`,
        `--baseline=${baselineFile}`,
        '--update-baseline',
      ],
      { cwd: evalsDir, env: { ...process.env, LITELLM_MASTER_KEY: 'sk-eval', EVALS_DATABASE_URL } },
    );

    const written = JSON.parse(await readFile(baselineFile, 'utf8')) as Report;
    expect(written.metrics).toBeDefined();
    await expect(readFile(path.join(evalsDir, 'baseline.json'), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('lets --gateway override the base URL that reaches openPipeline, independent of HARNESS_GATEWAY_URL', async () => {
    const outDir = path.join(dir, 'cli-gateway-override-out');
    await execFileAsync(
      tsxBin,
      [
        runScript,
        `--gateway=${gateway.url}`,
        `--out=${outDir}`,
        `--cases=${casesFile}`,
        `--corpus=${corpus}`,
        `--injection=${injectionFile}`,
        `--baseline=${path.join(dir, 'no-such-baseline.json')}`,
      ],
      {
        cwd: evalsDir,
        env: {
          ...process.env,
          LITELLM_MASTER_KEY: 'sk-eval',
          // Wrong on purpose: if the CLI used this instead of --gateway, every
          // extraction call would fail to connect and no field would ever
          // match, so a passing report here is only possible if --gateway's
          // base URL is what actually reached openPipeline.
          HARNESS_GATEWAY_URL: 'http://127.0.0.1:1',
          EVALS_DATABASE_URL,
        },
      },
    );

    const report = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8')) as Report;
    expect(report.splits.text_layer.failures).toBe(0);
    expect(report.splits.text_layer.fieldAccuracy).toBeGreaterThan(0);
  }, 120_000);
});
