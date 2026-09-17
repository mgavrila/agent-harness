/**
 * Create a client folder from a pack's defaults.
 *
 *   pnpm new-client --pack healthcare --name river-clinic
 *
 * A client is content and configuration, never code: this copies
 * `clients/demo-practice` and rewrites the client slug and display name. It
 * deliberately does not touch `.env`, because secrets are the operator's job.
 */
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
 * Files copied from the template. `routing.yaml` belongs to the model-gateway
 * plan; when it is not there yet, the new client simply does not get one and
 * the result says so.
 */
const TEMPLATE_FILES = [
  'SOUL.md',
  'hermes.config.yaml',
  'policy.yaml',
  'identity.yaml',
  '.env.example',
  'routing.yaml',
  'cron/playbooks.sh',
] as const;

/** Every `.sh` under this directory is copied too, so watchdogs travel with the client. */
const SCRIPT_DIR = 'scripts';

export interface NewClientOptions {
  pack: string;
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
  // Preserve the executable bit: a copied playbook installer must still run.
  const mode = (await stat(from)).mode;
  if (mode & 0o111) await chmod(to, mode & 0o777);
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

  const packDir = path.join(root, 'packs', pack);
  if (!(await exists(packDir))) throw new Error(`no pack named "${pack}" in ${path.join(root, 'packs')}`);

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

    const scriptsFrom = path.join(templateDir, SCRIPT_DIR);
    if (await exists(scriptsFrom)) {
      for (const entry of await readdir(scriptsFrom)) {
        if (!entry.endsWith('.sh')) continue;
        const relative = `${SCRIPT_DIR}/${entry}`;
        await copyTextFile(path.join(scriptsFrom, entry), path.join(dir, relative), templateSlug, name);
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
