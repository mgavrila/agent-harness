/**
 * Create a client folder from a pack's defaults.
 *
 *   pnpm new-client --pack healthcare --name river-clinic
 *   pnpm new-client --name internal-team            # a client with no pack
 *
 * A client is content and configuration, never code: five files, an env example and a
 * knowledge folder.
 * This copies `clients/demo-practice` and rewrites the client slug and display name. It
 * deliberately does not touch `.env`, because secrets are the operator's job.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A directory name that is also a safe Postgres `client` value and a safe path segment. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 40;

/** The template client every new client is cut from. */
const DEFAULT_TEMPLATE = 'demo-practice';
const TEMPLATE_DISPLAY_NAME = 'Demo Practice';

/**
 * Files copied from the template: the five files a client is made of, plus its env example.
 * A template missing one of them simply does not get it and the result says so.
 */
const TEMPLATE_FILES = [
  'SOUL.md',
  'identity.yaml',
  'policy.yaml',
  'routing.yaml',
  'playbooks.yaml',
  '.env.example',
] as const;

/**
 * Directories copied whole, file by file. Only markdown is taken: a client's knowledge folder is
 * documents, and a stray binary in the template is not something a new client should inherit. A
 * template with no such directory simply reports it under `skipped`, exactly as a missing file is
 * reported, because a client with no knowledge base is an ordinary client.
 */
const TEMPLATE_DIRS = ['knowledge'] as const;

export interface NewClientOptions {
  /**
   * The pack the client serves, checked against `packs/` so a typo fails here rather than at the
   * first start. Omitted for a client with no pack at all — `HARNESS_PACKS=''`, the kernel's own
   * tools and no product area — which is a client like any other: a folder, not code.
   */
  pack?: string;
  name: string;
  /** Repository root. Defaults to the directory above this file. */
  root?: string;
  /** Client folder to copy. Defaults to `demo-practice`. */
  template?: string;
}

export interface NewClientResult {
  dir: string;
  /** Paths written, relative to the new client directory. */
  files: string[];
  /** Template files that were not present and so were not copied. */
  skipped: string[];
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

/** Rewrite every mention of the template client. Slug first, then display name. */
function substitute(text: string, templateSlug: string, name: string): string {
  return text.replaceAll(templateSlug, name).replaceAll(TEMPLATE_DISPLAY_NAME, titleCase(name));
}

async function copyTextFile(from: string, to: string, templateSlug: string, name: string): Promise<void> {
  const text = await readFile(from, 'utf8');
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, substitute(text, templateSlug, name));
}

export async function newClient(opts: NewClientOptions): Promise<NewClientResult> {
  const root = opts.root ?? repoRoot();
  const templateSlug = opts.template ?? DEFAULT_TEMPLATE;
  const { name, pack } = opts;

  if (!NAME_PATTERN.test(name) || name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `name must be a lowercase slug of ${MIN_NAME_LENGTH} to ${MAX_NAME_LENGTH} characters, letters first, words joined by single hyphens (got "${name}")`,
    );
  }
  if (name === templateSlug) throw new Error(`name must differ from the template client "${templateSlug}"`);

  if (pack !== undefined) {
    const packDir = path.join(root, 'packs', pack);
    if (!(await exists(packDir))) throw new Error(`no pack named "${pack}" in ${path.join(root, 'packs')}`);
  }

  const templateDir = path.join(root, 'clients', templateSlug);
  if (!(await exists(templateDir))) throw new Error(`no template client at ${templateDir}`);

  const dir = path.join(root, 'clients', name);
  if (await exists(dir)) throw new Error(`clients/${name} already exists; remove it or pick another name`);

  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const skipped: string[] = [];

  try {
    for (const relative of TEMPLATE_FILES) {
      const from = path.join(templateDir, relative);
      if (!(await exists(from))) {
        skipped.push(relative);
        continue;
      }
      await copyTextFile(from, path.join(dir, relative), templateSlug, name);
      files.push(relative);
    }
    for (const directory of TEMPLATE_DIRS) {
      const from = path.join(templateDir, directory);
      if (!(await exists(from))) {
        skipped.push(`${directory}/`);
        continue;
      }
      for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const relative = `${directory}/${entry.name}`;
        await copyTextFile(path.join(templateDir, relative), path.join(dir, relative), templateSlug, name);
        files.push(relative);
      }
    }
  } catch (err) {
    // Never leave a half-written client directory behind: a retry should
    // see a clean slate, not "already exists" for a folder nobody can use.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  return { dir, files, skipped };
}
