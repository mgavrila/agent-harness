import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { documents, records, fields as fieldsTable, attachments as attachmentsTable } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import type { ToolDeps } from '../../domain/tooling/types.js';
import { connectTools, makeTestDeps, resultOf, useTestDb, startFakeGateway, type FakeGateway } from '../../testing.js';

const db = useTestDb();
let storageDir: string;
let deps: ToolDeps;

interface IngestOut {
  document_id: string;
  sha256: string;
  pages: number;
  storage_path: string;
  already_ingested: boolean;
}
interface DocOut {
  document: {
    id: string;
    provider_id: string | null;
    kind: string | null;
    pages: number | null;
    ocr_used: boolean;
    has_text: boolean;
  };
}

async function writePdf(rel: string, pageTexts: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    doc.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 12, font });
  }
  const abs = path.join(storageDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, await doc.save());
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-docs-healthcare-'));
  // Enough text per page that extractDocumentText reads the text layer rather
  // than falling back to OCR (see MIN_CHARS_PER_PAGE in domain/documents/text.ts).
  await writePdf('incoming/license.pdf', [
    'State of California Medical Board\nPhysician and Surgeon License\nName: Ada Lovelace MD\nNPI: 1234567890',
    'Specialty: Internal Medicine\nLicense Status: Active\nExpiration Date: 2027-03-31',
  ]);
  await writePdf('incoming/w9.pdf', ['Request for Taxpayer Identification']);
});
afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});
beforeEach(() => {
  deps = makeTestDeps(db, { storageDir });
});

const connect = () => connectTools('documents-test', healthcarePack.tools!(deps), deps);

async function seedProvider(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
  const res = await client.callTool({
    name: 'providers_upsert',
    arguments: { name: 'Dr. Ada Lovelace', npi: '1234567890' },
  });
  return resultOf<{ provider_id: string }>(res).provider_id;
}

describe('documents_ingest', () => {
  it('attaches to a provider and records the declared kind', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const out = resultOf<IngestOut>(
      await client.callTool({
        name: 'documents_ingest',
        arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' },
      }),
    );
    const row = (await db.select().from(documents)).find((d) => d.id === out.document_id)!;
    expect(row).toMatchObject({ recordId: providerId, kind: 'w9' });
  });

  it('back-fills the provider on a re-ingest that names one', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const first = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/w9.pdf' } }),
    );
    resultOf<IngestOut>(
      await client.callTool({
        name: 'documents_ingest',
        arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' },
      }),
    );
    const row = (await db.select().from(documents)).find((d) => d.id === first.document_id)!;
    expect(row).toMatchObject({ recordId: providerId, kind: 'w9' });
  });

  it('refuses an unknown provider', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: 'documents_ingest',
      arguments: { path: 'incoming/license.pdf', provider_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(documents)).toHaveLength(0);
  });
});

describe('documents_get and documents_list', () => {
  it('returns one document and lists a provider’s documents', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const a = resultOf<IngestOut>(
      await client.callTool({
        name: 'documents_ingest',
        arguments: { path: 'incoming/license.pdf', provider_id: providerId, kind: 'state_license' },
      }),
    );
    await client.callTool({
      name: 'documents_ingest',
      arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' },
    });

    const one = resultOf<DocOut>(
      await client.callTool({ name: 'documents_get', arguments: { document_id: a.document_id } }),
    );
    expect(one.document).toMatchObject({
      id: a.document_id,
      kind: 'state_license',
      pages: 2,
      ocr_used: false,
      has_text: false,
    });

    const many = resultOf<{ documents: DocOut['document'][] }>(
      await client.callTool({ name: 'documents_list', arguments: { provider_id: providerId } }),
    );
    expect(many.documents.map((d) => d.kind).sort()).toEqual(['state_license', 'w9']);
  });

  it('documents_list refuses another client’s provider', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const otherDeps = makeTestDeps(db, { storageDir, client: 'other' });
    const other = await connectTools('other-client', healthcarePack.tools!(otherDeps), otherDeps);
    const res = await other.callTool({ name: 'documents_list', arguments: { provider_id: providerId } });
    expect(res.isError).toBe(true);
  });
});

describe('documents_classify and documents_extract', () => {
  let gateway: FakeGateway;

  beforeAll(async () => {
    gateway = await startFakeGateway();
  });
  afterAll(async () => {
    await gateway.close();
  });

  function connectWithGateway(overrides: Partial<ToolDeps> = {}) {
    const d = makeTestDeps(db, {
      storageDir,
      gateway: { baseUrl: gateway.url, apiKey: 'sk-test', timeoutMs: 10_000, maxCallsPerRun: 100 },
      ...overrides,
    });
    deps = d;
    return connectTools('documents-pipeline', healthcarePack.tools!(d), d);
  }

  const EXTRACTION_REPLY = JSON.stringify({
    document_kind: 'state_license',
    fields: {
      first_name: { value: 'Ada', confidence: 0.98, source_page: 1 },
      last_name: { value: 'Lovelace', confidence: 0.98, source_page: 1 },
      npi: { value: '1234567890', confidence: 0.9, source_page: 1 },
      specialty: { value: 'Internal Medicine', confidence: 0.55, source_page: 1 },
    },
    credentials: [
      {
        kind: 'license',
        state: 'CA',
        issuer: 'Medical Board of California',
        issued_at: '2020-04-01',
        expires_at: '2027-03-31',
        confidence: 0.95,
        source_page: 1,
      },
    ],
  });

  it('extracts fields, creates the provider, and writes redacted text beside the document', async () => {
    gateway.setResponder(() => ({ content: EXTRACTION_REPLY }));
    const client = await connectWithGateway();
    const ing = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }),
    );
    const out = resultOf<{
      provider_id: string;
      document_kind: string;
      ocr_used: boolean;
      pages: number;
      fields_pending: number;
      fields_extracted: number;
      credentials: number;
      restricted_fields: string[];
    }>(await client.callTool({ name: 'documents_extract', arguments: { document_id: ing.document_id } }));

    expect(out.document_kind).toBe('state_license');
    expect(out.ocr_used).toBe(false);
    expect(out.pages).toBe(2);
    // specialty came back at 0.55, below the 0.85 threshold
    expect(out.fields_pending).toBe(1);
    expect(out.fields_extracted).toBe(3);
    expect(out.credentials).toBe(1);

    const stored = await db.select().from(fieldsTable).where(eq(fieldsTable.recordId, out.provider_id));
    expect(stored.find((f) => f.name === 'specialty')!.status).toBe('pending');
    expect(stored.find((f) => f.name === 'npi')!.sourceDocId).toBe(ing.document_id);
    expect(stored.find((f) => f.name === 'npi')!.sourcePage).toBe(1);

    const doc = (await db.select().from(documents)).find((d) => d.id === ing.document_id)!;
    expect(doc.textPath).toBe('incoming/license.pdf.redacted.txt');
    const text = await readFile(path.join(storageDir, doc.textPath!), 'utf8');
    expect(text).toContain('California');
  });

  it('attaches to an existing provider when one is named, without renaming it or touching its NPI', async () => {
    gateway.setResponder(() => ({ content: EXTRACTION_REPLY }));
    const client = await connectWithGateway();
    // A different NPI than EXTRACTION_REPLY's, and a name distinct from the
    // extracted "Ada Lovelace": if documents_extract ever fell back to
    // matching by name/NPI instead of writing to this exact row, either would
    // cause it to attach to (or create) a different provider.
    const seeded = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'providers_upsert', arguments: { name: 'Dr. Grace Hopper', npi: '9999999999' } }),
    );
    const providerId = seeded.provider_id;
    const before = (await db.select().from(records)).length;

    const ing = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }),
    );
    const out = resultOf<{ provider_id: string }>(
      await client.callTool({
        name: 'documents_extract',
        arguments: { document_id: ing.document_id, provider_id: providerId },
      }),
    );
    expect(out.provider_id).toBe(providerId);
    const doc = (await db.select().from(documents)).find((d) => d.id === ing.document_id)!;
    expect(doc.recordId).toBe(providerId);

    const providerRow = (await db.select().from(records)).find((p) => p.id === providerId)!;
    expect(providerRow.name).toBe('Dr. Grace Hopper');
    expect(providerRow.externalId).toBe('9999999999');
    expect(await db.select().from(records)).toHaveLength(before);

    const stored = await db.select().from(fieldsTable).where(eq(fieldsTable.recordId, providerId));
    expect(stored.find((f) => f.name === 'npi')?.value).toBe('1234567890');
  });

  it('refuses when the model returns no name and no provider was given', async () => {
    gateway.setResponder(() => ({ content: JSON.stringify({ document_kind: 'other', fields: {}, credentials: [] }) }));
    const client = await connectWithGateway();
    const ing = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }),
    );
    const res = await client.callTool({ name: 'documents_extract', arguments: { document_id: ing.document_id } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/no provider name/);
  });

  it('records the credential with its dates so deadlines can be computed', async () => {
    gateway.setResponder(() => ({ content: EXTRACTION_REPLY }));
    const client = await connectWithGateway();
    const ing = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }),
    );
    const out = resultOf<{ provider_id: string }>(
      await client.callTool({ name: 'documents_extract', arguments: { document_id: ing.document_id } }),
    );
    const creds = await db.select().from(attachmentsTable).where(eq(attachmentsTable.recordId, out.provider_id));
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({
      kind: 'license',
      state: 'CA',
      expiresAt: '2027-03-31',
      sourceDocId: ing.document_id,
    });
  });
});
