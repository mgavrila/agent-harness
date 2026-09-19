import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { pack as storiesPack } from '@harness/pack-stories';
import { generate } from '@harness/pack-stories/generate';
import { loadPacks, registryOf } from '../domain/packs/registry.js';
import { isRestrictedName } from '../shared/redaction/names.js';
import { createCoreToolsServer, publishedTools } from '../tools/catalog.js';
import { connectTestClient, makeTestDeps, resultOf, startFakeGateway, textOf, useTestDb } from '../testing.js';

const db = useTestDb();
const packs = registryOf([healthcarePack, storiesPack]);
const corpus = mkdtempSync(path.join(tmpdir(), 'stories-corpus-'));

beforeAll(async () => {
  await generate({ outDir: corpus });
});

describe('two packs in one process', () => {
  it('replaces only the seven same-named tools, leaving records_* for the other pack', () => {
    // Decision 3, asserted rather than assumed. If this list ever grows back to twelve, the
    // five records_* names below vanish process-wide and the stories pack has no record tools
    // at all — which is the exact failure this pack exists to catch.
    expect([...(healthcarePack.replaces ?? [])].sort()).toEqual([
      'deadlines_compute',
      'deadlines_upcoming',
      'documents_classify',
      'documents_extract',
      'documents_get',
      'documents_ingest',
      'documents_list',
    ]);
    expect(storiesPack.replaces).toBeUndefined();
  });

  it('loads both packs by the names a client document would carry', async () => {
    // Not `registryOf`: this is the path a server takes, a dynamic import of each package name.
    // The stories pack is a devDependency of core-tools, which is what makes that resolve here.
    const loaded = await loadPacks(['@harness/pack-healthcare', '@harness/pack-stories']);
    expect(loaded.all.map((p) => p.name)).toEqual(['healthcare', 'stories']);
    expect(loaded.skillsDirs()).toHaveLength(2);
  });

  it('publishes the union of both catalogues, with no name published twice', () => {
    const deps = makeTestDeps(db, { packs });
    const names = publishedTools(deps).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // Twenty-five kernel tools (sixteen from Plan 7, four memory and two playbook tools from
    // Plan 9, two knowledge tools from Plan 10, and `documents_read`), seven of them replaced by
    // healthcare, plus healthcare's eighteen: 25 − 7 + 18 = 36. The five records_* survive
    // because the stories pack's `epic` kind leaves genericTools true, so the publication gate
    // does not drop them. `documents_read` is in neither pack's `replaces`, so it is published
    // as the kernel defines it.
    expect(names).toHaveLength(36);
    for (const name of ['providers_get', 'forms_fill', 'verify_nppes', 'deadlines_upcoming']) {
      expect(names).toContain(name);
    }
    for (const name of [
      'records_upsert',
      'records_get',
      'records_search',
      'records_confirm_field',
      'records_list_pending',
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toContain('audit_query');
  });

  it('refuses to load two packs that claim the same document kind', () => {
    // The stories pack claims `meeting_notes` by name precisely so this does not happen to it,
    // and healthcare claims its own five rather than the catch-all it used to.
    const greedy = (name: string, documentKinds: string[]) => ({
      ...storiesPack,
      name,
      extraction: {
        ...storiesPack.extraction,
        targets: [{ ...storiesPack.extraction.targets[0], document_kinds: documentKinds }],
      },
    });
    expect(() => registryOf([healthcarePack, greedy('greedy', ['w9'])])).toThrow(
      'packs "healthcare" and "greedy" both claim document kind "w9"',
    );
    // And `'*'` is a kind for this purpose: a pack that reached for a second catch-all would
    // fail here rather than silently never receiving a document.
    expect(() => registryOf([greedy('one', ['*']), greedy('two', ['*'])])).toThrow('both claim document kind "*"');
  });

  it('offers both packs record kinds to records_* and both packs document kinds to documents_ingest', () => {
    expect(packs.recordKinds().map((r) => r.kind)).toEqual(['provider', 'epic']);
    expect(packs.attachmentKinds().map((a) => a.kind)).toEqual([
      'license',
      'dea',
      'malpractice',
      'board_cert',
      'source_link',
    ]);
    expect(packs.documentKinds()).toContain('state_license');
    expect(packs.documentKinds()).toContain('meeting_notes');
  });

  it('routes a meeting note to the epic target and a licence to the provider target', () => {
    expect(packs.targetFor('meeting_notes').recordKind.kind).toBe('epic');
    expect(packs.targetFor('state_license').recordKind.kind).toBe('provider');
    // Each pack's own prose reaches its own prompt: the role line and the example imperatives
    // the kernel's injection block quotes both come off the pack that claimed the document.
    expect(packs.targetFor('meeting_notes').injectionExamples).toEqual(storiesPack.extraction.injection_examples);
    expect(packs.targetFor('state_license').role).toBe(healthcarePack.extraction.role);
  });

  it('stores an epic through the generic tools and a provider through the healthcare aliases, in one database', async () => {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));

    const epic = resultOf<{ record_id: string }>(
      await client.callTool({
        name: 'records_upsert',
        arguments: { kind: 'epic', name: 'Audit export', fields: [{ name: 'owner', value: 'Dana Whitfield' }] },
      }),
    );
    const provider = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'providers_upsert', arguments: { name: 'Ada Reyes', npi: '1234567890' } }),
    );

    const readEpic = resultOf<{ record: { kind: string; name: string } }>(
      await client.callTool({ name: 'records_get', arguments: { record_id: epic.record_id } }),
    );
    expect(readEpic.record).toMatchObject({ kind: 'epic', name: 'Audit export' });

    // The generic tools reach the aliased kind too: one store, two front doors.
    const readProvider = resultOf<{ record: { kind: string; external_id: string | null } }>(
      await client.callTool({ name: 'records_get', arguments: { record_id: provider.provider_id } }),
    );
    expect(readProvider.record).toMatchObject({ kind: 'provider', external_id: '1234567890' });

    // But the healthcare read is pinned to its own kind, so an epic id is a refusal naming both
    // kinds rather than an epic returned through the provider schema.
    const wrongDoor = await client.callTool({
      name: 'providers_get',
      arguments: { provider_id: epic.record_id },
    });
    expect(wrongDoor.isError).toBe(true);
    expect(textOf(wrongDoor)).toContain('is a "epic" record, not a "provider" record');

    // And the healthcare search does not see the epic.
    const found = resultOf<{ providers: unknown[] }>(
      await client.callTool({ name: 'providers_search', arguments: { query: 'Audit export' } }),
    );
    expect(found.providers).toEqual([]);
  });

  it('runs the stories intake end to end against the fake gateway and produces an epic', async () => {
    const fake = await startFakeGateway(() => ({
      content: JSON.stringify({
        document_kind: 'meeting_notes',
        fields: {
          title: { value: 'Audit export', confidence: 0.98, source_page: 1 },
          summary: { value: 'Enterprise customers export their audit log as CSV.', confidence: 0.93, source_page: 1 },
          owner: { value: 'Dana Whitfield', confidence: 0.97, source_page: 1 },
          target_quarter: { value: '2027-Q1', confidence: 0.95, source_page: 1 },
        },
        links: [
          {
            kind: 'source_link',
            issuer: 'JIRA',
            state: '',
            issued_at: '',
            expires_at: '',
            confidence: 0.9,
            source_page: 1,
          },
        ],
      }),
    }));
    onTestFinished(() => fake.close());
    const deps = makeTestDeps(db, {
      packs,
      storageDir: corpus,
      gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
    });
    const client = await connectTestClient(() => createCoreToolsServer(deps));

    const ingested = resultOf<{ document_id: string }>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'notes-03.pdf', kind: 'meeting_notes' } }),
    );
    // documents_ingest is healthcare's wrapper in this process — it replaced the kernel's — and
    // it works for a stories document unchanged, because a document is attached to a record and
    // the kernel decides which kind from the extraction target.
    const extracted = resultOf<{ record_id: string; document_kind: string; attachments: number }>(
      await client.callTool({ name: 'documents_extract', arguments: { document_id: ingested.document_id } }),
    );
    expect(extracted.document_kind).toBe('meeting_notes');

    // The `document_kind` enum the model was offered holds the owning pack's kinds and nothing
    // else. Healthcare's five are loaded in this process, and `parseExtraction` would discard
    // any of them as `'other'` for a stories document — so offering one could only ever buy a
    // wrong answer that is then thrown away and written to `documents.kind`.
    const format = fake.calls.at(-1)?.responseFormat as {
      json_schema: { schema: { properties: { document_kind: { enum: string[] } } } };
    };
    expect(format.json_schema.schema.properties.document_kind.enum).toEqual(['meeting_notes']);
    expect(packs.documentKinds().length).toBeGreaterThan(1);

    // The healthcare wrapper answers for a foreign document in the kernel's words, not its own:
    // this is an epic, so there is no `provider_id` and no `credentials` to report.
    expect(extracted).not.toHaveProperty('provider_id');
    expect(extracted).not.toHaveProperty('credentials');
    expect(extracted.attachments).toBe(1);

    const stored = resultOf<{
      record: { kind: string; name: string };
      fields: { name: string; value: string | null }[];
    }>(await client.callTool({ name: 'records_get', arguments: { record_id: extracted.record_id, kind: 'epic' } }));
    expect(stored.record).toMatchObject({ kind: 'epic', name: 'Audit export' });
    expect(stored.fields.find((f) => f.name === 'owner')?.value).toBe('Dana Whitfield');

    // The injected imperative in notes-03 is content, not an instruction: nothing it asked for
    // happened, and it is not stored as a value.
    for (const field of stored.fields) {
      expect(field.value ?? '').not.toContain('roadmap-leaks@example.invalid');
    }

    // The document is on file under the epic, and healthcare's documents_get hands it back as
    // the kernel produced it rather than renaming the epic to a provider.
    const document = resultOf<{ document: { record_id: string; kind: string } }>(
      await client.callTool({ name: 'documents_get', arguments: { document_id: ingested.document_id } }),
    );
    expect(document.document).toMatchObject({ record_id: extracted.record_id, kind: 'meeting_notes' });
  });

  /**
   * One epic with one `source_link`, so the two deadline cases below differ in one argument.
   *
   * The compute goes through the *kernel's* `deadlines_compute`, reached on `deps.kernelTools`
   * because healthcare's wrapper holds that name in the published catalogue. That is the tool an
   * epic belongs to: the wrapper now pins `record_kind: 'provider'` and refuses this id, which
   * the case below asserts directly.
   */
  async function deadlinesForLink(attachment: Record<string, string>): Promise<string[]> {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const epic = resultOf<{ record_id: string }>(
      await client.callTool({
        name: 'records_upsert',
        arguments: {
          kind: 'epic',
          name: 'Usage-based billing',
          attachments: [{ kind: 'source_link', issuer: 'JIRA', ...attachment }],
        },
      }),
    );
    const compute = deps.kernelTools.get('deadlines_compute');
    expect(compute).toBeDefined();
    const computed = (await compute!.handler({ record_id: epic.record_id }, deps)) as {
      deadlines: { kind: string }[];
    };
    return computed.deadlines.map((d) => d.kind);
  }

  it('computes an expiration but no renewal for an attachment kind with no lead days', async () => {
    // A date was given, so there is something to expire. `leadDays: 0` is what removes the
    // renewal_start deadline, rather than scheduling a renewal for the day the thing lapses.
    expect(await deadlinesForLink({ expires_at: '2027-12-31' })).toEqual(['expiration']);
  });

  it('computes no deadline at all for an attachment that carries no expiry date', async () => {
    // The case the previous test was named for and did not make: `source_link` declares no
    // `expires_at` property, so a tracker link is stored without one and nothing about it is ever
    // due. A kernel that assumed everything hung off a record lapses would schedule against
    // `null` here, which is how an epic ended up in a renewals digest.
    expect(await deadlinesForLink({})).toEqual([]);
  });

  it("refuses an epic id through healthcare's deadlines_compute, naming both kinds", async () => {
    // The published `deadlines_compute` is healthcare's wrapper and it answers in credentialing
    // words — `credential_id` for every row. Recomputing an epic through it would report the
    // epic's tracker link under that name, so the wrapper pins `record_kind: 'provider'` and the
    // kernel refuses the id instead. The message names what the record is and what was expected.
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const epic = resultOf<{ record_id: string }>(
      await client.callTool({
        name: 'records_upsert',
        arguments: {
          kind: 'epic',
          name: 'Seat-based billing',
          attachments: [{ kind: 'source_link', issuer: 'JIRA', expires_at: '2027-12-31' }],
        },
      }),
    );
    const res = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: epic.record_id } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('is a "epic" record, not a "provider" record');

    // And the epic's own deadlines are untouched by the refused call.
    const compute = deps.kernelTools.get('deadlines_compute');
    const computed = (await compute!.handler({ record_id: epic.record_id }, deps)) as {
      deadlines: { kind: string }[];
    };
    expect(computed.deadlines.map((d) => d.kind)).toEqual(['expiration']);
  });

  it('gives every loaded pack an evals block whose judged fields hold no restricted name', () => {
    for (const p of packs.all) {
      expect(p.evals).toBeDefined();
      expect(p.evals!.judgedFields.filter((f) => isRestrictedName(f))).toEqual([]);
    }
  });
});
