import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
}

/**
 * Where an attachment lands, relative to `incoming/`: the message timestamp (dot to dash, so the
 * name has one dot at most) and the file name with everything outside `[A-Za-z0-9._-]` replaced.
 * Two messages cannot share a `ts`, and `documents_ingest` is idempotent by content, so a file
 * shared twice is stored twice and ingested once.
 */
export function attachmentPath(ts: string, name: string): string {
  return `${ts.replace('.', '-')}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Fetch each file with the bot token into `<storageDir>/incoming/`. A failure drops that one
 * file and warns with its name only: the URL is a signed private link and the message is a log
 * line. The target is checked against the storage root before anything is written.
 */
export async function downloadAttachments(
  ts: string,
  files: readonly SlackFile[],
  deps: DownloadDeps,
): Promise<{ name: string; path: string }[]> {
  const doFetch = deps.fetch ?? fetch;
  const incoming = path.join(deps.storageDir, 'incoming');
  await mkdir(incoming, { recursive: true });
  const out: { name: string; path: string }[] = [];
  for (const file of files) {
    const relative = attachmentPath(ts, file.name);
    try {
      const target = await assertInsideRoot(relative, incoming, () => {
        throw new Error('attachment path escapes the incoming directory');
      });
      const res = await doFetch(file.url, { headers: { authorization: `Bearer ${deps.token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
      out.push({ name: file.name, path: relative });
    } catch (err) {
      deps.log.warn(
        `slack: could not save attachment "${file.name}" (${err instanceof Error ? err.message : 'error'}); it is left out of the message`,
      );
    }
  }
  return out;
}
