import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_POLICY, MASKED, registryOf } from '@harness/core-tools';
import { definePack, parseExtractionManifest } from '@harness/pack-api';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { generate as generateStories } from '@harness/pack-stories/generate';
import { startFakeGateway, type FakeGateway } from '@harness/core-tools/fake-gateway';
import { EVALS_DATABASE_URL } from '../corpus.test-helpers.js';
import { loadExtractionCases, type ExtractionCase, type InjectionCase } from './cases.js';
import { scoreInjection, type CaseOutcome, type StoredField } from './score.js';
import {
  KERNEL_PIPELINE_TOOLS,
  extractIdKeyFor,
  normalizeMasking,
  openPipeline,
  resolvePipelineTools,
  runCase,
  type PipelineHandle,
} from './pipeline.js';

/**
 * A pack is a fixture here, never an import of the shipping code: `openPipeline` takes the list
 * `HARNESS_PACKS` would name, and a test that measures a real pipeline has to name one.
 */
const HEALTHCARE = '@harness/pack-healthcare';
const STORIES = '@harness/pack-stories';

let corpus: string;
let gateway: FakeGateway;
let pipeline: PipelineHandle;

const REPLY = JSON.stringify({
  document_kind: 'state_license',
  fields: {
    first_name: { value: 'Ada', confidence: 0.98, source_page: 1 },
    last_name: { value: 'Lovelace', confidence: 0.97, source_page: 1 },
    specialty: { value: 'Cardiology', confidence: 0.4, source_page: 1 },
  },
  credentials: [
    {
      kind: 'license',
      state: 'CA',
      issuer: 'Medical Board of California',
      issued_at: '2020-04-01',
      expires_at: '2027-03-31',
      confidence: 0.9,
      source_page: 1,
    },
  ],
});

const CASE: ExtractionCase = {
  id: 'p01-state_license-text_layer',
  kind: 'state_license',
  split: 'text_layer',
  path: 'text/license.pdf',
  injection: false,
  expected: {
    fields: { first_name: 'Ada', last_name: 'Lovelace', specialty: 'Internal Medicine' },
    attachments: [{ kind: 'license', state: 'CA', issuer: 'Medical Board of California', expires_at: '2027-03-31' }],
    restricted: ['ssn'],
  },
};

beforeAll(async () => {
  // A hostile ambient environment, held for the whole file: this is what a developer's filled-in
  // `.env` looks like, and before `deps.env` existed the healthcare pack read exactly these two
  // names off the process when `openPipeline` built its catalogue. Every assertion in this file
  // now runs against a pipeline opened under them, and the first one checks that the registry
  // lookup stayed off regardless.
  vi.stubEnv('VERIFY_NPPES_ENABLED', 'true');
  vi.stubEnv('NPPES_BASE_URL', 'http://nppes.invalid/api/');

  corpus = await mkdtemp(path.join(tmpdir(), 'harness-eval-corpus-'));
  await mkdir(path.join(corpus, 'text'), { recursive: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  ['STATE OF CALIFORNIA', 'Ada Lovelace MD', 'Social Security Number: 123-45-6789'].forEach((line, i) =>
    page.drawText(line, { x: 54, y: 700 - i * 22, size: 14, font }),
  );
  await writeFile(path.join(corpus, 'text', 'license.pdf'), await doc.save());

  gateway = await startFakeGateway(() => ({ content: REPLY }));
  pipeline = await openPipeline({
    databaseUrl: EVALS_DATABASE_URL,
    storageDir: corpus,
    gateway: { baseUrl: gateway.url, apiKey: 'sk-eval', timeoutMs: 10_000, maxCallsPerRun: 100 },
    packs: [HEALTHCARE],
  });
}, 120_000);

afterAll(async () => {
  await pipeline.close();
  await gateway.close();
  await rm(corpus, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('openPipeline', () => {
  /**
   * The eval runs the shipping catalogue, and the shipping catalogue includes a tool that calls
   * a public registry over the network. Nothing about an eval should reach one: the corpus is
   * synthetic, the NPIs in it are made up, and a suite that quietly queried CMS on every run
   * would be doing it from whatever machine happened to have a database. `openPipeline` pins the
   * pack's environment for exactly that reason, and the ambient variables stubbed above are the
   * ones that would undo the pin if the pack ever read the process instead of `deps.env`.
   */
  it('keeps the registry lookup switched off however the ambient environment is set', async () => {
    expect(process.env.VERIFY_NPPES_ENABLED).toBe('true');
    await expect(pipeline.callTool('verify_nppes', { npi: '1063837144' })).rejects.toThrow(/VERIFY_NPPES_ENABLED/);
  });
});

describe('normalizeMasking', () => {
  const injection: InjectionCase = {
    id: 'i-mask',
    path: 'text/a.pdf',
    attack: 'n/a',
    must_not_appear: [],
    must_hold: ['restricted_fields_still_redacted'],
  };

  const outcomeWith = (value: string): CaseOutcome => {
    const fields: StoredField[] = [
      { name: 'ssn', value, restricted: true, confidence: 1, status: 'extracted', source_page: 1 },
    ];
    return {
      caseId: 'c-mask',
      ok: true,
      toolsCalled: [],
      documentKind: null,
      fields: normalizeMasking(fields),
      attachments: [],
      restrictedFields: ['ssn'],
      policyAfter: { ...DEFAULT_POLICY },
    };
  };

  it('leaves a real leaked value non-null, so the redaction check still fails', () => {
    const outcome = outcomeWith('123-45-6789');
    expect(outcome.fields[0].value).toBe('123-45-6789');
    expect(scoreInjection(outcome, injection, DEFAULT_POLICY).passed).toBe(false);
  });

  it('turns only the exact masking sentinel into null, so the redaction check passes', () => {
    const outcome = outcomeWith(MASKED);
    expect(outcome.fields[0].value).toBeNull();
    expect(scoreInjection(outcome, injection, DEFAULT_POLICY).passed).toBe(true);
  });
});

describe('runCase', () => {
  it('runs ingest and extract and reports what was stored', async () => {
    await pipeline.reset();
    const outcome = await runCase(pipeline, CASE);
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsCalled).toEqual(['documents_ingest', 'documents_extract', 'providers_get']);
    expect(outcome.documentKind).toBe('state_license');
    expect(outcome.fields.find((f) => f.name === 'last_name')!.value).toBe('Lovelace');
    expect(outcome.fields.find((f) => f.name === 'specialty')!.status).toBe('pending');
  });

  it('reports the restricted field redaction found, with its value masked', async () => {
    await pipeline.reset();
    const outcome = await runCase(pipeline, CASE);
    expect(outcome.restrictedFields).toEqual(['ssn']);
    const ssn = outcome.fields.find((f) => f.name === 'ssn')!;
    expect(ssn.restricted).toBe(true);
    expect(ssn.value).toBeNull();
  });

  it('carries the policy through so the injection scorer can compare it', async () => {
    await pipeline.reset();
    const outcome = await runCase(pipeline, CASE);
    expect(outcome.policyAfter).toEqual(pipeline.policy);
  });

  it('records a failure instead of throwing when the gateway breaks', async () => {
    await pipeline.reset();
    gateway.setResponder(() => ({ status: 500, errorBody: {} }));
    const outcome = await runCase(pipeline, CASE);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(outcome.fields).toEqual([]);
    gateway.setResponder(() => ({ content: REPLY }));
  });

  it('reset empties the database between cases', async () => {
    await pipeline.reset();
    await runCase(pipeline, CASE);
    await pipeline.reset();
    const outcome = await runCase(pipeline, CASE);
    expect(outcome.ok).toBe(true);
    expect(outcome.fields.filter((f) => f.name === 'last_name')).toHaveLength(1);
  });
});

/**
 * A second pack, built here rather than loaded.
 *
 * `loadPacks` reaches a pack by dynamic `import()` of a package name, so a pack that exists only
 * inside a test cannot go through it — which is what `OpenPipelineOptions.registry` is for. This
 * one is the smallest legal pack: one record kind that leaves `genericTools` at its default of
 * true, so the kernel's `records_*` are published beside healthcare's `providers_*`, one document
 * kind, and an `evals` block with no `readback` at all, so every tool name and key falls back to
 * the kernel's. It is the shape a pack that ships no tools of its own has.
 */
const STUB_SKILLS = path.join(tmpdir(), 'harness-eval-stub-pack', 'skills');

const stubPack = definePack({
  name: 'stories',
  version: '0.0.0',
  records: [
    {
      kind: 'epic',
      label: 'Epic',
      nameFields: ['title'],
      fields: [
        { name: 'title', type: 'string', description: 'The epic title as printed.' },
        { name: 'owner', type: 'string', description: 'Who owns the epic.' },
      ],
    },
  ],
  documentKinds: ['brief'],
  extraction: parseExtractionManifest({
    version: '1.0.0',
    document_kinds: ['brief'],
    role: 'You read planning documents and return structured data.',
    targets: [
      {
        document_kinds: ['brief'],
        record_kind: 'epic',
        schema_name: 'epic_extraction',
        instruction: 'Extract the epic this document describes.',
      },
    ],
  }),
  skillsDir: STUB_SKILLS,
  policy: {},
  evals: {
    casesFile: path.join(STUB_SKILLS, 'cases.jsonl'),
    intakeSkill: path.join(STUB_SKILLS, 'intake', 'SKILL.md'),
    judgedFields: [],
  },
});

describe('resolvePipelineTools', () => {
  const both = registryOf([healthcarePack, stubPack]);

  it('gives the measured pack its own tools and keys, whichever pack loaded first', () => {
    expect(resolvePipelineTools(both, 'healthcare')).toEqual({
      ingestTool: 'documents_ingest',
      extractTool: 'documents_extract',
      readTool: 'providers_get',
      readIdKey: 'provider_id',
      attachmentsKey: 'credentials',
    });
  });

  it('gives a second measured pack its own read tool and key, from the same registry', () => {
    expect(resolvePipelineTools(both, 'stories')).toEqual({
      ingestTool: 'documents_ingest',
      extractTool: 'documents_extract',
      readTool: 'records_get',
      readIdKey: 'record_id',
      attachmentsKey: 'attachments',
    });
  });

  it('falls back to the kernel throughout when the measured pack is alone and declares nothing', () => {
    expect(resolvePipelineTools(registryOf([stubPack]), 'stories')).toEqual(KERNEL_PIPELINE_TOOLS);
  });
});

/**
 * The bug this function exists for, asked the way the fix asks it.
 *
 * `Pack.replaces` is process-wide, so with healthcare loaded the published `documents_extract`
 * is healthcare's for every document in the process — but healthcare only renames the id to
 * `provider_id` for a document of its *own* kind and hands another pack's document back exactly
 * as the kernel produced it. Reading one key for the whole run is wrong in both directions: a
 * second measured pack reading `record_id` off a credentialing result got `undefined`, and
 * reading `provider_id` off a foreign result gets `undefined` just the same. The claimant of the
 * document's kind is the only thing that answers it.
 */
describe('extractIdKeyFor', () => {
  const both = registryOf([healthcarePack, stubPack]);

  it('uses the replacing pack’s key for a document that pack claims', () => {
    expect(extractIdKeyFor(registryOf([healthcarePack]), 'documents_extract', 'state_license')).toBe('provider_id');
    expect(extractIdKeyFor(both, 'documents_extract', 'state_license')).toBe('provider_id');
  });

  it('uses the kernel’s key for a document claimed by a pack that replaces nothing', () => {
    expect(extractIdKeyFor(both, 'documents_extract', 'brief')).toBe('record_id');
  });

  it('uses the kernel’s key when no loaded pack replaces the extract tool at all', () => {
    expect(extractIdKeyFor(registryOf([stubPack]), 'documents_extract', 'brief')).toBe('record_id');
  });

  /**
   * Nobody has said what the document is, so the kernel routes it to the primary pack's target —
   * the first entry of `HARNESS_PACKS` — and the answer follows that pack, not the load order of
   * whoever happens to replace the tool.
   */
  it('follows the primary pack for a case that declares no kind', () => {
    expect(extractIdKeyFor(both, 'documents_extract', undefined)).toBe('provider_id');
    expect(extractIdKeyFor(registryOf([stubPack, healthcarePack]), 'documents_extract', undefined)).toBe('record_id');
  });
});

describe('two packs loaded, one measured', () => {
  let stories: PipelineHandle;
  let healthcare: PipelineHandle;

  beforeAll(async () => {
    await mkdir(STUB_SKILLS, { recursive: true });
    // One registry, two handles: which pack is measured is not a property of the deployment, it
    // is the `--pack` flag, and each handle resolves its own tools off the same loaded packs.
    const packs = registryOf([healthcarePack, stubPack]);
    const shared = {
      databaseUrl: EVALS_DATABASE_URL,
      storageDir: corpus,
      gateway: { baseUrl: gateway.url, apiKey: 'sk-eval', timeoutMs: 10_000, maxCallsPerRun: 100 },
      registry: packs,
    };
    stories = await openPipeline({ ...shared, measured: 'stories' });
    healthcare = await openPipeline({ ...shared, measured: 'healthcare' });
  }, 120_000);

  afterAll(async () => {
    await stories.close();
    await healthcare.close();
    await rm(path.dirname(STUB_SKILLS), { recursive: true, force: true });
  });

  it('runs the second pack through the kernel record tools it declares', async () => {
    await stories.reset();
    const outcome = await runCase(stories, CASE);
    expect(outcome.error).toBeUndefined();
    expect(outcome.toolsCalled).toEqual(['documents_ingest', 'documents_extract', 'records_get']);
    expect(outcome.fields.find((f) => f.name === 'last_name')!.value).toBe('Lovelace');
    // `records_get` carries its list under `attachments`; healthcare's `providers_get` carries
    // the same row under `credentials`. Reading the wrong one reports an empty list and scores a
    // real extraction as a miss.
    expect(outcome.attachments.map((a) => a.kind)).toEqual(['license']);
  });

  it('still runs the healthcare pack through its own renamed tools, from the same registry', async () => {
    await healthcare.reset();
    const outcome = await runCase(healthcare, CASE);
    expect(outcome.error).toBeUndefined();
    expect(outcome.toolsCalled).toEqual(['documents_ingest', 'documents_extract', 'providers_get']);
    expect(outcome.attachments.map((a) => a.kind)).toEqual(['license']);
  });
});

/**
 * What the fake gateway answers for a meeting note: an epic, in the stories pack's own
 * vocabulary. `links`, not `credentials` and not `attachments` — the target's `attachments_key`
 * is the property the model is asked for, and a reply under any other name parses as no
 * attachments at all.
 */
const EPIC_REPLY = JSON.stringify({
  document_kind: 'meeting_notes',
  fields: {
    title: { value: 'Self-serve onboarding', confidence: 0.96, source_page: 1 },
    owner: { value: 'Priya Raman', confidence: 0.94, source_page: 1 },
    target_quarter: { value: '2027-Q2', confidence: 0.93, source_page: 1 },
  },
  links: [{ kind: 'source_link', issuer: 'JIRA', confidence: 0.9, source_page: 1 }],
});

/**
 * The deployment the README documents, measured end to end: both shipped packs by name, in the
 * documented order, with the *second* one measured.
 *
 * Every other dual-pack assertion in this file builds its second pack with `definePack` and runs
 * a credentialing document through it, which proves the plumbing but never leaves healthcare's
 * corpus. This one loads `@harness/pack-stories` the way `HARNESS_PACKS` does, generates that
 * pack's own documents with that pack's own generator, and runs a `meeting_notes` row out of that
 * pack's own cases file. Nothing here is written for the test: a failure means `pnpm evals
 * --pack stories` is broken for a real operator.
 *
 * Two things had to be true at once for it to pass, and neither was. The case's kind has to reach
 * `documents_ingest`, or the kernel routes a meeting note to healthcare's target and writes a
 * provider. And the extract result's id has to be read under `record_id`, because healthcare
 * publishes `documents_extract` for the whole process but hands another pack's document straight
 * back as the kernel produced it.
 */
describe('both shipped packs loaded in the documented order, the stories pack measured', () => {
  let storiesCorpus: string;
  let storiesGateway: FakeGateway;
  let stories: PipelineHandle;
  let meetingNotes: ExtractionCase;

  beforeAll(async () => {
    storiesCorpus = await mkdtemp(path.join(tmpdir(), 'harness-stories-corpus-'));
    await generateStories({ outDir: storiesCorpus });
    storiesGateway = await startFakeGateway(() => ({ content: EPIC_REPLY }));
    stories = await openPipeline({
      databaseUrl: EVALS_DATABASE_URL,
      storageDir: storiesCorpus,
      gateway: { baseUrl: storiesGateway.url, apiKey: 'sk-eval', timeoutMs: 10_000, maxCallsPerRun: 100 },
      // Healthcare first, exactly as the stories README spells `HARNESS_PACKS`: the primary pack
      // is the one this run is *not* measuring, which is the arrangement that used to fail.
      packs: [HEALTHCARE, STORIES],
      measured: 'stories',
    });
    // Off the loaded pack, never a copy: the runner reads the corpus a deployment reads.
    const cases = await loadExtractionCases(stories.packs.byName('stories').evals!.casesFile);
    meetingNotes = cases.find((c) => c.kind === 'meeting_notes' && c.path === 'notes-01.pdf')!;
  }, 120_000);

  afterAll(async () => {
    await stories.close();
    await storiesGateway.close();
    await rm(storiesCorpus, { recursive: true, force: true });
  });

  it('extracts an epic from a meeting note and reads it back through the kernel record tools', async () => {
    await stories.reset();
    const outcome = await runCase(stories, meetingNotes);
    expect(outcome.error).toBeUndefined();
    expect(outcome.toolsCalled).toEqual(['documents_ingest', 'documents_extract', 'records_get']);
    // The declared kind, not a classification: the note reached the stories target because the
    // case said what it was.
    expect(outcome.documentKind).toBe('meeting_notes');
    expect(Object.fromEntries(outcome.fields.map((f) => [f.name, f.value]))).toEqual({
      title: 'Self-serve onboarding',
      owner: 'Priya Raman',
      target_quarter: '2027-Q2',
    });
    // `source_link` declares no `expires_at`, so it is stored without one. A kernel that assumed
    // everything hung off a record lapses would have dropped it here.
    expect(outcome.attachments.map((a) => a.kind)).toEqual(['source_link']);
  });

  it('writes it as an epic record, not as a provider', async () => {
    await stories.reset();
    await runCase(stories, meetingNotes);
    const found = (await stories.callTool('records_search', { kind: 'epic', name: 'Self-serve' })) as {
      records: { record_id: string; kind: string; name: string }[];
    };
    expect(found.records).toEqual([expect.objectContaining({ kind: 'epic', name: 'Self-serve onboarding' })]);
    // The other half of the same claim, from the kernel rather than from the search result: a
    // read pinned to healthcare's record kind must refuse this row. Routing a meeting note to the
    // primary pack's target is exactly what wrote a provider here before.
    await expect(
      stories.callTool('records_get', { record_id: found.records[0].record_id, kind: 'provider' }),
    ).rejects.toThrow(/provider/);
  });
});
