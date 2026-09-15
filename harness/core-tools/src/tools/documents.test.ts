import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { documents } from '@harness/db';
import type { ToolDeps } from '../registry.js';
import { connectTools, makeTestDeps, resultOf, useTestDb } from '../testing.js';
import { providerTools } from './providers.js';
import { documentTools } from './documents.js';

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
  document: { id: string; provider_id: string | null; kind: string | null; pages: number | null; ocr_used: boolean; has_text: boolean };
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
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-docs-'));
  await writePdf('incoming/license.pdf', ['California Medical Board', 'page two']);
  await writePdf('incoming/w9.pdf', ['Request for Taxpayer Identification']);
  await writeFile(path.join(storageDir, 'incoming', 'notes.txt'), 'plain text notes');
});
afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});
beforeEach(() => {
  deps = makeTestDeps(db, { storageDir });
});

const connect = () => connectTools('documents-test', [...providerTools, ...documentTools], deps);

async function seedProvider(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
  const res = await client.callTool({ name: 'providers_upsert', arguments: { name: 'Dr. Ada Lovelace', npi: '1234567890' } });
  return resultOf<{ provider_id: string }>(res).provider_id;
}

describe('documents_ingest', () => {
  it('hashes the file, counts pages, and stores a row', async () => {
    const client = await connect();
    const out = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }));
    expect(out.pages).toBe(2);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.storage_path).toBe('incoming/license.pdf');
    expect(out.already_ingested).toBe(false);
    const rows = await db.select().from(documents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ocrUsed: false, textPath: null, kind: null });
  });

  it('is idempotent on the same sha256 and reports it', async () => {
    const client = await connect();
    const first = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }));
    const again = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }));
    expect(again.document_id).toBe(first.document_id);
    expect(again.already_ingested).toBe(true);
    expect(await db.select().from(documents)).toHaveLength(1);
  });

  it('attaches to a provider and records the declared kind', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const out = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' } }),
    );
    const row = (await db.select().from(documents)).find((d) => d.id === out.document_id)!;
    expect(row).toMatchObject({ providerId, kind: 'w9' });
  });

  it('back-fills the provider on a re-ingest that names one', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const first = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/w9.pdf' } }));
    resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' } }),
    );
    const row = (await db.select().from(documents)).find((d) => d.id === first.document_id)!;
    expect(row).toMatchObject({ providerId, kind: 'w9' });
  });

  it('refuses a path outside the storage dir', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'documents_ingest', arguments: { path: '../../etc/passwd' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/outside HARNESS_STORAGE_DIR/);
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

  it('accepts a non-PDF file as a single page', async () => {
    const client = await connect();
    const out = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/notes.txt' } }));
    expect(out.pages).toBe(1);
  });

  it('refuses a symlink under the storage dir that points outside it', async () => {
    const client = await connect();
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'harness-outside-'));
    try {
      const secret = path.join(outsideDir, 'secret.pdf');
      await writeFile(secret, 'top secret');
      const link = path.join(storageDir, 'incoming', 'escape-link.pdf');
      await symlink(secret, link);
      const res = await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/escape-link.pdf' } });
      expect(res.isError).toBe(true);
      const message = JSON.stringify(res.content);
      expect(message).toMatch(/outside HARNESS_STORAGE_DIR/);
      expect(message).not.toContain(secret);
      expect(await db.select().from(documents)).toHaveLength(0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('ingests a document reached through a symlink that stays inside the storage dir', async () => {
    const client = await connect();
    const link = path.join(storageDir, 'incoming', 'license-link.pdf');
    await symlink(path.join(storageDir, 'incoming', 'license.pdf'), link);
    const out = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license-link.pdf' } }));
    expect(out.pages).toBe(2);
  });
});

describe('documents_get and documents_list', () => {
  it('returns one document and lists a provider’s documents', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const a = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf', provider_id: providerId, kind: 'state_license' } }),
    );
    await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/w9.pdf', provider_id: providerId, kind: 'w9' } });

    const one = resultOf<DocOut>(await client.callTool({ name: 'documents_get', arguments: { document_id: a.document_id } }));
    expect(one.document).toMatchObject({ id: a.document_id, kind: 'state_license', pages: 2, ocr_used: false, has_text: false });

    const many = resultOf<{ documents: DocOut['document'][] }>(
      await client.callTool({ name: 'documents_list', arguments: { provider_id: providerId } }),
    );
    expect(many.documents.map((d) => d.kind).sort()).toEqual(['state_license', 'w9']);
  });

  it('documents_get refuses an unknown id', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'documents_get', arguments: { document_id: '00000000-0000-0000-0000-000000000000' } });
    expect(res.isError).toBe(true);
  });

  it('documents_list refuses another client’s provider', async () => {
    const client = await connect();
    const providerId = await seedProvider(client);
    const other = await connectTools('other-client', [...providerTools, ...documentTools], makeTestDeps(db, { storageDir, client: 'other' }));
    const res = await other.callTool({ name: 'documents_list', arguments: { provider_id: providerId } });
    expect(res.isError).toBe(true);
  });

  it('an unattached document ingested by one client is invisible to another', async () => {
    const owner = await connect();
    const otherClient = await connectTools(
      'other-clinic',
      [...providerTools, ...documentTools],
      makeTestDeps(db, { storageDir, client: 'other-clinic' }),
    );
    const ingested = resultOf<IngestOut>(
      await otherClient.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/notes.txt' } }),
    );

    const getRes = await owner.callTool({ name: 'documents_get', arguments: { document_id: ingested.document_id } });
    expect(getRes.isError).toBe(true);

    const listed = resultOf<{ documents: DocOut['document'][] }>(
      await owner.callTool({ name: 'documents_list', arguments: {} }),
    );
    expect(listed.documents.find((d) => d.id === ingested.document_id)).toBeUndefined();
  });

  it('documents_list without a provider filter returns only this client’s documents', async () => {
    const client = await connect();
    const otherClient = await connectTools(
      'other-clinic-2',
      [...providerTools, ...documentTools],
      makeTestDeps(db, { storageDir, client: 'other-clinic-2' }),
    );
    const mine = resultOf<IngestOut>(await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/notes.txt' } }));
    await otherClient.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } });

    const listed = resultOf<{ documents: DocOut['document'][] }>(
      await client.callTool({ name: 'documents_list', arguments: {} }),
    );
    expect(listed.documents.map((d) => d.id)).toEqual([mine.document_id]);
  });
});
