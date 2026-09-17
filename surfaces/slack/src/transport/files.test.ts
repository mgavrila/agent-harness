import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentPath, downloadAttachments } from './files.js';

let storageDir: string;
const log = { info() {}, warn() {}, error() {} };
beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-slack-files-'));
});
afterEach(() => rm(storageDir, { recursive: true, force: true }));

const fakeFetch = (bodies: Record<string, string | number>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    const body = bodies[key];
    if (typeof body === 'number') return new Response('nope', { status: body });
    return new Response(body, {
      status: 200,
      headers: { 'x-auth': String((init?.headers as Record<string, string>)?.authorization) },
    });
  }) as typeof fetch;

describe('attachmentPath', () => {
  it('prefixes the message timestamp and neutralises the file name', () => {
    expect(attachmentPath('1789000000.000001', 'Dr Reyes licence (2026).pdf')).toBe(
      '1789000000-000001-Dr_Reyes_licence__2026_.pdf',
    );
    expect(attachmentPath('1.2', '../../etc/passwd')).toBe('1-2-.._.._etc_passwd');
  });
});

describe('downloadAttachments', () => {
  it('writes each file under incoming/ with the bot token and returns paths relative to incoming', async () => {
    const fetch = fakeFetch({ 'https://files.slack.com/a': 'PDF-A', 'https://files.slack.com/b': 'PDF-B' });
    const out = await downloadAttachments(
      '1789000000.000001',
      [
        { name: 'a.pdf', url: 'https://files.slack.com/a' },
        { name: 'b.pdf', url: 'https://files.slack.com/b' },
      ],
      { token: 'xoxb-test', storageDir, fetch, log },
    );
    expect(out).toEqual([
      { name: 'a.pdf', path: '1789000000-000001-a.pdf' },
      { name: 'b.pdf', path: '1789000000-000001-b.pdf' },
    ]);
    expect(await readFile(path.join(storageDir, 'incoming', '1789000000-000001-a.pdf'), 'utf8')).toBe('PDF-A');
  });

  it('sends the bot token as a bearer', async () => {
    let seen: string | undefined;
    // Named `fetchStub`, not `fetch`: `const fetch = ... as typeof fetch` self-references the
    // declaration being typed (TS7022) rather than the ambient global.
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>).authorization;
      return new Response('x');
    }) as typeof fetch;
    await downloadAttachments('1.1', [{ name: 'x', url: 'https://files.slack.com/x' }], {
      token: 'xoxb-test',
      storageDir,
      fetch: fetchStub,
      log,
    });
    expect(seen).toBe('Bearer xoxb-test');
  });

  it('drops a file whose download fails, logs it, and keeps the others', async () => {
    const warned: string[] = [];
    const fetch = fakeFetch({ 'https://files.slack.com/ok': 'fine', 'https://files.slack.com/bad': 500 });
    const out = await downloadAttachments(
      '1.1',
      [
        { name: 'bad.pdf', url: 'https://files.slack.com/bad' },
        { name: 'ok.pdf', url: 'https://files.slack.com/ok' },
      ],
      { token: 't', storageDir, fetch, log: { ...log, warn: (m: string) => warned.push(m) } },
    );
    expect(out).toEqual([{ name: 'ok.pdf', path: '1-1-ok.pdf' }]);
    expect(warned[0]).toContain('bad.pdf');
    expect(warned[0]).not.toContain('files.slack.com');
  });
});
