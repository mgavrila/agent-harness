import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { assertInsideRoot, type Logger } from '@harness/shared';
import { ParseError } from './errors.js';
import { extractDocument, type ExtractOptions } from './extract.js';

/** A request names one path; anything longer than this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export interface FilesServerDeps {
  storageDir: string;
  log: Logger;
  options?: ExtractOptions;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ParseError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ParseError(400, 'request body is not JSON');
  }
}

/**
 * The requested path, resolved inside the root, or refused. The same primitive core-tools uses
 * for the same check: lexical and symlink-resolved, so neither `..` nor a planted link escapes.
 * The path is never repeated in a refusal: the caller chose it.
 */
async function resolveInside(storageDir: string, requested: unknown): Promise<string> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new ParseError(400, 'path must be a non-empty string relative to the storage root');
  }
  if (path.isAbsolute(requested)) throw new ParseError(403, 'path must be relative to the storage root');
  return assertInsideRoot(
    requested,
    storageDir,
    () => {
      throw new ParseError(403, 'path is outside the storage root');
    },
    { allowRoot: false },
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The worker's HTTP surface: a health probe and one parsing route. */
export function createFilesServer(deps: FilesServerDeps): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
      if (req.method !== 'POST' || req.url !== '/extract') return send(res, 404, { error: 'not found' });
      const body = (await readJson(req)) as { path?: unknown } | null;
      const abs = await resolveInside(deps.storageDir, body?.path);
      send(res, 200, await extractDocument(abs, deps.options));
    } catch (err) {
      if (err instanceof ParseError) return send(res, err.status, { error: err.message });
      // Logged in full here, where the log is the operator's; the reply carries no errno text,
      // because an errno message names the file.
      deps.log.error('extract failed', err);
      send(res, 500, { error: 'document could not be parsed' });
    }
  }
  return createServer((req, res) => {
    void handle(req, res);
  });
}
