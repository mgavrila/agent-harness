import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import { writePdf } from './pdf.test-helpers.js';
import { joinPages, localParser, remoteParser } from './parser.js';

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-parser-'));
  // Enough text per page to clear MIN_CHARS_PER_PAGE, so the text layer is read and no OCR runs.
  await writePdf(storageDir, 'incoming/two-pages.pdf', [
    'Page one. The quick brown fox jumps over the lazy dog, twice over, for good measure.',
    'Page two. Expiration Date: 2027-03-31 and a licence number A98765 printed in full.',
  ]);
});
afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('localParser', () => {
  it('reads a text-layer PDF under the storage root, page by page', async () => {
    const out = await localParser(storageDir).extract('incoming/two-pages.pdf');
    expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
    expect(out.pages[1].text).toContain('A98765');
    expect(out.ocrUsed).toBe(false);
    // No joined copy: building one here would be the whole document over again beside the pages
    // just returned, and nothing in this package reads it. `joinPages` is what a caller that
    // wants one string calls.
    expect(out.text).toBeUndefined();
    expect(joinPages(out.pages)).toBe(`${out.pages[0].text}\n\n${out.pages[1].text}`);
  });

  it('reads only the pages of a range that is asked for', async () => {
    const out = await localParser(storageDir).extract('incoming/two-pages.pdf', { from: 2, to: 2 });
    expect(out.pages.map((p) => p.num)).toEqual([2]);
    expect(out.pages[0].text).toContain('A98765');
  });

  it('refuses a path outside the storage root before touching the filesystem', async () => {
    const parser = localParser(storageDir);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(ToolError);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
    await expect(parser.extract('/etc/hostname')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
  });
});

describe('remoteParser', () => {
  let stub: Server;
  let base: string;
  const requests: { url: string | undefined; body: unknown }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));

  it('posts the relative path and hands the worker’s pages back untouched', async () => {
    requests.length = 0;
    reply = { status: 200, body: { pages: [{ num: 1, text: 'hello' }], text: 'hello', ocrUsed: true } };
    const out = await remoteParser(`${base}/`, storageDir).extract('incoming/two-pages.pdf');
    // The worker's `text` is checked as part of its wire shape and then dropped: it is the pages
    // over again, and holding it here is a second complete copy of the document.
    expect(out).toEqual({ pages: [{ num: 1, text: 'hello' }], ocrUsed: true });
    expect(requests).toEqual([{ url: '/extract', body: { path: 'incoming/two-pages.pdf' } }]);
  });

  it('refuses a path outside the root before anything is sent (invariant 5)', async () => {
    requests.length = 0;
    await expect(remoteParser(base, storageDir).extract('../outside.pdf')).rejects.toThrow(
      /outside HARNESS_STORAGE_DIR/,
    );
    expect(requests).toEqual([]);
  });

  it('turns a refusal into a ToolError carrying the worker’s message, which is safe by construction', async () => {
    reply = { status: 415, body: { error: 'unsupported document type .zip; expected a PDF or an image' } };
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(
      /document parser refused \(HTTP 415\): unsupported document type \.zip/,
    );
  });

  it('turns an unreachable worker and a malformed answer into ToolErrors', async () => {
    await expect(remoteParser('http://127.0.0.1:1', storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(
      /document parser is unreachable/,
    );
    reply = { status: 200, body: { pages: 'nope' } };
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(ToolError);
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(/unexpected shape/);
  });
});
