import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@harness/shared';
import { missingBinaries } from './extract.js';
import { createFilesServer } from './server.js';

let storageDir: string;
let outsideDir: string;
let base: string;
let close: () => Promise<void>;

const popplerAvailable = (await missingBinaries()).every((name) => name === 'tesseract' || name === 'pdftoppm');

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-files-server-'));
  outsideDir = await mkdtemp(path.join(tmpdir(), 'harness-files-outside-'));
  await mkdir(path.join(storageDir, 'incoming'));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('State of California Medical Board. Licence A98765 expires 2027-03-31.', {
    x: 50,
    y: 700,
    size: 12,
    font,
  });
  await writeFile(path.join(storageDir, 'incoming', 'license.pdf'), await doc.save());
  await writeFile(path.join(outsideDir, 'secret.pdf'), 'top secret');
  await symlink(path.join(outsideDir, 'secret.pdf'), path.join(storageDir, 'incoming', 'escape.pdf'));

  const server = createFilesServer({ storageDir, log: createLogger('files-test') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterAll(async () => {
  await close();
  await rm(storageDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe('POST /extract', () => {
  it.skipIf(!popplerAvailable)('parses a document under the storage root', async () => {
    const { status, json } = await post({ path: 'incoming/license.pdf' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ocrUsed: false, pages: [{ num: 1 }] });
    expect((json as { pages: { text: string }[] }).pages[0].text).toContain('A98765');
  });

  it('refuses an absolute path and a path that climbs out, and never quotes either', async () => {
    for (const bad of ['/etc/hostname', '../outside.pdf', 'incoming/../../x.pdf']) {
      const { status, json } = await post({ path: bad });
      expect(status, bad).toBe(403);
      expect(JSON.stringify(json)).not.toContain(bad);
      expect(JSON.stringify(json)).not.toContain(storageDir);
    }
  });

  it('refuses a symlink under the root that points outside it', async () => {
    const { status } = await post({ path: 'incoming/escape.pdf' });
    expect(status).toBe(403);
  });

  it('answers 400 to a body that is not JSON or has no path, and 404 to a file that is not there', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ path: 'incoming/missing.pdf' })).status).toBe(404);
  });

  it('answers 404, not 500, to a path that traverses through a regular file', async () => {
    const { status, json } = await post({ path: 'incoming/license.pdf/y' });
    expect(status).toBe(404);
    expect(JSON.stringify(json)).not.toContain(storageDir);
  });

  it('answers 404 to any other route and 200 to the health probe', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });
});
