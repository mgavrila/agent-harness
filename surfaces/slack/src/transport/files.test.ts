import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentPath, downloadAttachments, MAX_ATTACHMENT_BYTES } from './files.js';

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

  it('neutralises the timestamp too, defensively', () => {
    // Slack never sends a `ts` shaped like this; the guard exists so the same rule that protects
    // the name protects the prefix, regardless of where the string came from.
    expect(attachmentPath('1.1/../evil', 'x.pdf')).toBe('1-1_.._evil-x.pdf');
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
    // The warn line is built from the error's class, never its message, because a filesystem
    // error's message carries the absolute path it failed on.
    expect(warned[0]).not.toContain(storageDir);
  });

  it('suffixes a repeated file name so two attachments in one message never collide', async () => {
    const fetch = fakeFetch({ 'https://files.slack.com/a': 'first', 'https://files.slack.com/b': 'second' });
    const out = await downloadAttachments(
      '1.1',
      [
        { name: 'w9.pdf', url: 'https://files.slack.com/a' },
        { name: 'w9.pdf', url: 'https://files.slack.com/b' },
      ],
      { token: 't', storageDir, fetch, log },
    );
    expect(out).toEqual([
      { name: 'w9.pdf', path: '1-1-w9.pdf' },
      { name: 'w9.pdf', path: '1-1-w9-2.pdf' },
    ]);
    expect(await readFile(path.join(storageDir, 'incoming', '1-1-w9.pdf'), 'utf8')).toBe('first');
    expect(await readFile(path.join(storageDir, 'incoming', '1-1-w9-2.pdf'), 'utf8')).toBe('second');
  });
});

describe('downloadAttachments host pinning', () => {
  it('refuses a URL that is not https on a Slack host, never sending the bot token', async () => {
    for (const url of ['http://evil.example/x.pdf', 'https://evil.example/x.pdf', 'http://files.slack.com/x.pdf']) {
      const warned: string[] = [];
      let called = 0;
      const fetchStub = (async () => {
        called += 1;
        return new Response('x');
      }) as typeof fetch;
      const out = await downloadAttachments('1.1', [{ name: 'x.pdf', url }], {
        token: 'xoxb-test',
        storageDir,
        fetch: fetchStub,
        log: { ...log, warn: (m: string) => warned.push(m) },
      });
      expect(called).toBe(0);
      expect(out).toEqual([]);
      expect(warned[0]).toContain('x.pdf');
      expect(warned[0]).not.toContain('evil.example');
    }
  });

  it('fetches a files.slack.com URL and a workspace subdomain, and refuses a redirect', async () => {
    const seen: (string | undefined)[] = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response('PDF');
    }) as typeof fetch;
    const out = await downloadAttachments(
      '1.1',
      [
        { name: 'a.pdf', url: 'https://files.slack.com/files-pri/T1-F1/a.pdf' },
        { name: 'b.pdf', url: 'https://acme.enterprise.slack.com/files-pri/T1-F2/b.pdf' },
      ],
      { token: 'xoxb-test', storageDir, fetch: fetchStub, log },
    );
    expect(out).toEqual([
      { name: 'a.pdf', path: '1-1-a.pdf' },
      { name: 'b.pdf', path: '1-1-b.pdf' },
    ]);
    expect(seen).toEqual(['error', 'error']);
  });

  it('refuses a host that merely ends with the Slack host as a suffix', async () => {
    let called = 0;
    const fetchStub = (async () => {
      called += 1;
      return new Response('x');
    }) as typeof fetch;
    const out = await downloadAttachments('1.1', [{ name: 'x.pdf', url: 'https://notslack.com/x.pdf' }], {
      token: 't',
      storageDir,
      fetch: fetchStub,
      log,
    });
    expect(called).toBe(0);
    expect(out).toEqual([]);
  });
});

describe('downloadAttachments size cap', () => {
  it('exports a 64 MiB default', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('rejects a declared content-length over the limit before reading the body, and writes nothing', async () => {
    const warned: string[] = [];
    const fetchStub = (async () =>
      new Response('short', { status: 200, headers: { 'content-length': '999999' } })) as typeof fetch;
    const out = await downloadAttachments('1.1', [{ name: 'huge.pdf', url: 'https://files.slack.com/huge' }], {
      token: 't',
      storageDir,
      fetch: fetchStub,
      maxBytes: 20,
      log: { ...log, warn: (m: string) => warned.push(m) },
    });
    expect(out).toEqual([]);
    await expect(readFile(path.join(storageDir, 'incoming', '1-1-huge.pdf'))).rejects.toThrow();
    expect(warned[0]).toContain('huge.pdf');
    expect(warned[0]).toContain('20');
    expect(warned[0]).not.toContain(storageDir);
  });

  it('aborts a chunked body once it passes the limit, and removes the partial file', async () => {
    const warned: string[] = [];
    const fetchStub = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(15));
          controller.enqueue(new Uint8Array(15));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const out = await downloadAttachments('1.1', [{ name: 'stream.pdf', url: 'https://files.slack.com/stream' }], {
      token: 't',
      storageDir,
      fetch: fetchStub,
      maxBytes: 20,
      log: { ...log, warn: (m: string) => warned.push(m) },
    });
    expect(out).toEqual([]);
    await expect(readFile(path.join(storageDir, 'incoming', '1-1-stream.pdf'))).rejects.toThrow();
    expect(warned[0]).toContain('stream.pdf');
  });

  it('writes a body under the limit as before', async () => {
    const fetchStub = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const out = await downloadAttachments('1.1', [{ name: 'small.pdf', url: 'https://files.slack.com/small' }], {
      token: 't',
      storageDir,
      fetch: fetchStub,
      maxBytes: 20,
      log,
    });
    expect(out).toEqual([{ name: 'small.pdf', path: '1-1-small.pdf' }]);
    expect(await readFile(path.join(storageDir, 'incoming', '1-1-small.pdf'), 'utf8')).toBe('ok');
  });
});
