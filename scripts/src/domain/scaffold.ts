/**
 * Create a client, as a document, in a directory that is not this repository.
 *
 *   pnpm new-client --name river-clinic --display-name "River Clinic" --pack healthcare
 *   pnpm new-client --name internal-team --target /srv/tenants
 *
 * A client is content and configuration, never code, and after Plan 11a it is not in this
 * repository either: the target defaults to `HARNESS_CLIENTS_DIR` and the scaffolder refuses to
 * run with neither that nor `--target`. What it writes is one `client.yaml` — the whole document
 * — and one `persona.md` the document `!include`s, because a persona is the one field a person
 * edits as prose. It deliberately does not touch `.env`: secrets are the operator's job.
 */
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { parseWithIncludes } from '@harness/config-files';
import { optionalEnv } from '@harness/shared';

/** A directory name that is also a safe Postgres `client` value and a safe path segment. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 40;

/**
 * The document every new client starts from: the one fixture this repository still holds.
 *
 * It is read rather than written out here so that a field added to the document schema reaches a
 * new client the moment the fixture carries it, instead of the day somebody remembers this file.
 */
const FIXTURE_CLIENT = 'fixture';

export interface NewClientOptions {
  name: string;
  /** What a human calls this client. Defaults to the name, title-cased. */
  displayName?: string;
  /**
   * The pack the client serves, checked against `packs/` so a typo fails here rather than at the
   * first start. Omitted for a client with no pack at all, which is a client like any other: a
   * document, not code.
   */
  pack?: string;
  /**
   * Where the client is written, one sub-directory per client. Defaults to
   * `HARNESS_CLIENTS_DIR`, and with neither this refuses rather than guessing at a directory.
   */
  target?: string;
  /** The runtime plug-in that owns this client's loop. Defaults to the fixture's. */
  runtime?: string;
}

export interface NewClientResult {
  dir: string;
  /** Paths written, relative to the new client directory. */
  files: string[];
}

export function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function repoRoot(): string {
  // scripts/src/domain -> the repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The document, as YAML, with the persona put back as an `!include`.
 *
 * The `yaml` package will not emit a custom tag it did not parse, so the persona is dropped from
 * the object and the one line that refers to the file is appended by hand. Everything else is
 * stringified, which is what keeps this function ignorant of the document's shape.
 *
 * `lineWidth: 0` turns folding off. With it on, a skill's markdown comes back out as a folded
 * scalar with a blank line between every line of it, which round-trips correctly and is unusable
 * to the person who has to edit it; a literal block is the same text with the newlines left alone.
 */
function renderDocument(document: ClientDocument): string {
  const { persona: _persona, ...rest } = document;
  return [
    `# ${document.displayName}, as one client document. See ARCHITECTURE.md, "The client document".`,
    '# Written by `pnpm new-client`; everything below is yours to edit.',
    toYaml(rest, { lineWidth: 0 }).trimEnd(),
    '',
    '# The one field a person edits as prose, so it lives in a file of its own.',
    'persona: !include persona.md',
    '',
  ].join('\n');
}

export async function newClient(opts: NewClientOptions): Promise<NewClientResult> {
  const { name, pack, runtime } = opts;
  const displayName = opts.displayName ?? titleCase(name);

  if (!NAME_PATTERN.test(name) || name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `name must be a lowercase slug of ${MIN_NAME_LENGTH} to ${MAX_NAME_LENGTH} characters, letters first, words joined by single hyphens (got "${name}")`,
    );
  }

  const target = opts.target ?? optionalEnv('HARNESS_CLIENTS_DIR');
  if (!target) {
    throw new Error(
      'nowhere to write: pass --target or set HARNESS_CLIENTS_DIR. A client does not live in this repository.',
    );
  }

  const root = repoRoot();
  if (pack !== undefined && !(await exists(path.join(root, 'packs', pack)))) {
    throw new Error(`no pack named "${pack}" in ${path.join(root, 'packs')}`);
  }

  const dir = path.join(target, name);
  if (await exists(dir)) throw new Error(`${dir} already exists; remove it or pick another name`);

  const fixture = parseClientDocument(
    await parseWithIncludes(path.join(root, 'clients', FIXTURE_CLIENT, 'client.yaml')),
  );
  const document = parseClientDocument({
    ...fixture,
    id: name,
    displayName,
    // The fixture's persona with its own name taken out of it. A person rewrites this file; what
    // the scaffolder owes them is prose that is about their client rather than about a fixture.
    persona: fixture.persona.replaceAll(fixture.displayName, displayName),
    packs: pack === undefined ? [] : [`@harness/pack-${pack}`],
    // Relative to the client's own directory, which is what the files source resolves it against.
    knowledge: { source: 'dir', path: 'knowledge' },
    // A new client schedules nothing until somebody asks it to.
    playbooks: { playbooks: [] },
    ...(runtime === undefined ? {} : { runtime }),
  });

  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, 'client.yaml'), renderDocument(document), 'utf8');
    await writeFile(path.join(dir, 'persona.md'), document.persona, 'utf8');
    // The directory the document above declares, empty. A `knowledge` section that names a
    // directory which is not there is a document the files source refuses to load at all, so the
    // two are written together or the client cannot start until somebody guesses why.
    if (document.knowledge.source === 'dir') await mkdir(path.join(dir, document.knowledge.path), { recursive: true });
  } catch (err) {
    // Never leave a half-written client directory behind: a retry should see a clean slate, not
    // "already exists" for a directory nobody can use.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  return { dir, files: ['client.yaml', 'persona.md'] };
}
