import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChangelogSection } from '../domain/changelog.js';

/**
 * `pnpm release:notes <version>` — one version's section of the changelog, on stdout.
 *
 * The release workflow redirects this into the body of the GitHub Release it creates, so a
 * missing section fails the release before anything is published rather than after.
 */
const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: pnpm release:notes <version>\n');
  process.exit(1);
}
// scripts/src/app -> scripts/src -> scripts -> the repository root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
process.stdout.write(`${readChangelogSection(changelog, version)}\n`);
