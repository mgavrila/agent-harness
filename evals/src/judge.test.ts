import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, isRestrictedName, type ToolDeps } from '@harness/core-tools';
import { startFakeGateway, type FakeGateway } from '@harness/core-tools/fake-gateway';
import { createDb, runMigrations } from '@harness/db';
import { FREE_TEXT_FIELDS, judgeFreeText, type JudgeItem } from './judge.js';

const DATABASE_URL = process.env.EVALS_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_evals';
const here = path.dirname(fileURLToPath(import.meta.url));

let gateway: FakeGateway;
let deps: ToolDeps;
let closeDb: () => Promise<void>;

const VERDICT = (index: number, same: boolean) => ({ index, same, why: 'because' });

beforeAll(async () => {
  await runMigrations(DATABASE_URL);
  gateway = await startFakeGateway(() => ({ content: JSON.stringify({ verdicts: [VERDICT(0, true)] }) }));
  const handle = createDb(DATABASE_URL);
  closeDb = handle.close;
  deps = {
    db: handle.db,
    client: 'evals',
    caller: 'judge',
    policy: { ...DEFAULT_POLICY },
    encryptionKey: randomBytes(32),
    now: () => new Date(),
    approvalTtlHours: 24,
    confidenceThreshold: 0.85,
    gateway: { baseUrl: gateway.url, apiKey: 'sk-eval', timeoutMs: 10_000, maxCallsPerRun: 100 },
    storageDir: here,
    restrictedToModel: false,
    verify: { nppesEnabled: false, nppesBaseUrl: 'http://127.0.0.1:1/api/', stateLicenseEnabled: false, timeoutMs: 5_000 },
    sinks: {},
    context: {},
    tools: new Map(),
  };
}, 120_000);

afterAll(async () => {
  await closeDb();
  await gateway.close();
});

const item = (over: Partial<JudgeItem> = {}): JudgeItem => ({
  field: 'practice_name',
  expected: 'Medical Group of San Francisco',
  actual: 'San Francisco Medical Group',
  split: 'text_layer',
  ...over,
});

describe('FREE_TEXT_FIELDS', () => {
  it('names no restricted field, so no restricted value can reach the judge', () => {
    for (const field of FREE_TEXT_FIELDS) expect(isRestrictedName(field)).toBe(false);
  });

  it('names no field the healthcare pack marks restricted', async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(here, '../../packs/healthcare/schema/provider.json'), 'utf8'),
    ) as { fields: { name: string; restricted?: boolean }[] };
    const restricted = manifest.fields.filter((f) => f.restricted === true).map((f) => f.name);
    expect(restricted.length).toBeGreaterThan(0);
    for (const field of FREE_TEXT_FIELDS) expect(restricted).not.toContain(field);
  });
});

describe('judgeFreeText', () => {
  it('judges nothing and calls no model when there is nothing to judge', async () => {
    const before = gateway.calls.length;
    expect(await judgeFreeText(deps, [])).toEqual({ scored: 0, agreed: 0, agreementRate: 1, verdicts: [] });
    expect(gateway.calls).toHaveLength(before);
  });

  it('sends one call carrying only the field name and the two strings', async () => {
    const before = gateway.calls.length;
    await judgeFreeText(deps, [item()]);
    expect(gateway.calls).toHaveLength(before + 1);

    const call = gateway.calls[before];
    expect(call.model).toBe('judge');
    const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('practice_name');
    expect(user).toContain('Medical Group of San Francisco');
    // The split is bookkeeping for the runner, not something the grader needs.
    expect(user).not.toContain('text_layer');
  });

  it('carries each item split onto its verdict so credit stays with one split', async () => {
    gateway.setResponder(() => ({ content: JSON.stringify({ verdicts: [VERDICT(0, true), VERDICT(1, false)] }) }));
    const result = await judgeFreeText(deps, [item(), item({ split: 'scan', field: 'specialty' })]);
    expect(result?.verdicts.map((v) => [v.split, v.same])).toEqual([
      ['text_layer', true],
      ['scan', false],
    ]);
    expect(result?.agreed).toBe(1);
    expect(result?.agreementRate).toBe(0.5);
  });

  it('drops a restricted field rather than putting it in a prompt', async () => {
    const before = gateway.calls.length;
    const result = await judgeFreeText(deps, [item({ field: 'ssn', expected: 'x', actual: 'y' })]);
    expect(result).toEqual({ scored: 0, agreed: 0, agreementRate: 1, verdicts: [] });
    expect(gateway.calls).toHaveLength(before);
  });

  it('refuses to call the judge when a value carries an unredacted identifier', async () => {
    // The last gate, run over the exact messages about to go out. Nothing is
    // expected to reach it — no restricted field survives the filter above —
    // but a value that arrived from somewhere the filter does not cover must
    // stop the call, not be downgraded to "judge unavailable" and swallowed.
    const before = gateway.calls.length;
    await expect(
      judgeFreeText(deps, [item({ field: 'practice_name', actual: 'Riverside, SSN 123-45-6789' })]),
    ).rejects.toThrow(/not redacted/);
    expect(gateway.calls).toHaveLength(before);
  });

  it('counts a pair the model skipped as a miss rather than a match', async () => {
    gateway.setResponder(() => ({ content: JSON.stringify({ verdicts: [VERDICT(0, true)] }) }));
    const result = await judgeFreeText(deps, [item(), item({ split: 'scan' })]);
    expect(result?.verdicts[1]).toMatchObject({ same: false, why: 'no verdict returned' });
    expect(result?.agreed).toBe(1);
  });

  it('returns null instead of throwing when the judge route is down', async () => {
    gateway.setResponder(() => ({ status: 500 }));
    // Null, not zeros: a judge that could not be reached has no agreement rate,
    // and a zeroed result would be scored as one.
    expect(await judgeFreeText(deps, [item()])).toBeNull();
    gateway.setResponder(() => ({ content: JSON.stringify({ verdicts: [VERDICT(0, true)] }) }));
  });

  it('returns null when the reply does not match the verdict schema', async () => {
    gateway.setResponder(() => ({ content: 'not json at all' }));
    expect(await judgeFreeText(deps, [item()])).toBeNull();
    gateway.setResponder(() => ({ content: JSON.stringify({ verdicts: [VERDICT(0, true)] }) }));
  });
});
