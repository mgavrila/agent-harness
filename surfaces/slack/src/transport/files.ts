import { createWriteStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { assertInsideRoot, type Logger } from '@harness/shared';

export interface SlackFile {
  name: string;
  url: string;
}

export interface DownloadDeps {
  token: string;
  /** The storage root; files land under its `incoming/`. */
  storageDir: string;
  fetch?: typeof fetch;
  log: Logger;
  /** Overrides `MAX_ATTACHMENT_BYTES`. For a test that would otherwise have to stream tens of megabytes. */
  maxBytes?: number;
}

/**
 * Slack allows attachments up to 1 GiB. Buffering one whole in memory, or writing one with no
 * limit at all, lets a single message exhaust the host's memory or fill the storage volume. This
 * is well past anything a pack's forms need and comfortably below what one message should cost.
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** Raised by `writeCapped` for a body that is, or turns out to be, over the limit. */
class AttachmentTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`exceeds the ${limit}-byte limit`);
    this.name = 'AttachmentTooLargeError';
  }
}

/**
 * Where an attachment lands, relative to `incoming/`: the message timestamp (dot to dash, then
 * the same neutralising as the name) and the file name with everything outside
 * `[A-Za-z0-9._-]` replaced. Two messages cannot share a `ts`, and `documents_ingest` is
 * idempotent by content, so a file shared twice is stored twice and ingested once.
 */
export function attachmentPath(ts: string, name: string): string {
  const safeTs = ts.replace('.', '-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safeTs}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Suffixes `relative` with `-2`, `-3`, ... before its extension until it is not in `used`. */
function dedupe(relative: string, used: Set<string>): string {
  if (!used.has(relative)) {
    used.add(relative);
    return relative;
  }
  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Write `res`'s body to `target`, refusing and cleaning up once it is over `limit`.
 *
 * A declared `content-length` over the limit is refused before a single byte is read. That
 * alone is not enough — the header is whatever Slack sent, absent for a chunked body and not
 * itself verified against what actually arrives — so every chunk is counted as it is written,
 * and going over the limit aborts the pipeline and deletes whatever was written so far.
 */
async function writeCapped(res: Response, target: string, limit: number): Promise<void> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    throw new AttachmentTooLargeError(limit);
  }
  if (!res.body) {
    await writeFile(target, Buffer.alloc(0));
    return;
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new AttachmentTooLargeError(limit));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    // `Response.body`'s DOM-flavoured `ReadableStream` and Node's `stream/web` one are the same
    // shape at runtime; only their ambient type declarations disagree on the finer generics.
    const body = res.body as unknown as NodeWebReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(body), limiter, createWriteStream(target));
  } catch (err) {
    await unlink(target).catch(() => undefined);
    throw err;
  }
}

/** Raised for a URL the download refuses to send the bot token to. */
class UntrustedHostError extends Error {
  constructor() {
    super('the URL is not an https Slack host');
    this.name = 'UntrustedHostError';
  }
}

/**
 * Where the bot token may be sent: Slack's own file host over TLS, and nothing else.
 *
 * `url_private_download` comes from the inbound payload, and the request carries the workspace's
 * bot token as a bearer. A payload naming another host would hand that token to whoever answers
 * there, so the host is pinned here rather than trusted from the event, and `redirect: 'error'`
 * at the call site keeps the answer from moving the request somewhere else afterwards. Node's
 * `fetch` does drop `Authorization` across origins, which is a second line, not the first.
 */
function isSlackFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // `files.slack.com` is what Slack sends today; an enterprise grid signs the same URL on a
  // workspace subdomain, which is why the suffix is allowed and not just the one host. The leading
  // dot matters: without it `notslack.com` would pass.
  return url.hostname.toLowerCase().endsWith('.slack.com');
}

/** The safe part of what went wrong: never a message, which may carry the absolute target path. */
function reason(err: unknown): string {
  if (err instanceof AttachmentTooLargeError || err instanceof UntrustedHostError) return err.message;
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? err.name;
  return 'error';
}

/**
 * Fetch each file with the bot token into `<storageDir>/incoming/`. A failure — a URL that is not
 * an https Slack host, the request, the size cap, or the write — drops that one file and warns
 * with its name and the reason, never a path or the signed URL. The target is checked against the storage root before anything is
 * written, and two attachments sharing a name in one message are kept apart by a numeric suffix.
 */
export async function downloadAttachments(
  ts: string,
  files: readonly SlackFile[],
  deps: DownloadDeps,
): Promise<{ name: string; path: string }[]> {
  const doFetch = deps.fetch ?? fetch;
  const limit = deps.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const incoming = path.join(deps.storageDir, 'incoming');
  await mkdir(incoming, { recursive: true });
  const out: { name: string; path: string }[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const relative = dedupe(attachmentPath(ts, file.name), used);
    try {
      const target = await assertInsideRoot(relative, incoming, () => {
        throw new Error('attachment path escapes the incoming directory');
      });
      if (!isSlackFileUrl(file.url)) throw new UntrustedHostError();
      const res = await doFetch(file.url, {
        headers: { authorization: `Bearer ${deps.token}` },
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeCapped(res, target, limit);
      out.push({ name: file.name, path: relative });
    } catch (err) {
      deps.log.warn(
        `slack: could not save attachment "${path.basename(file.name)}" (${reason(err)}); it is left out of the message`,
      );
    }
  }
  return out;
}
