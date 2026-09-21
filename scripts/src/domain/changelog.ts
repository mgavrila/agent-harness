import { ConfigError } from '@harness/shared';

/**
 * One version's section of the changelog, without its own heading and without the next one.
 *
 * The release body is written by a person, in the file the repository already keeps, rather than
 * generated from commit subjects: a consumer reading a release wants to know what moved under
 * them, and "fix(host): tidy" is not that. The heading is `## <version>` followed by anything —
 * a date, usually — and the section ends at the next `## `.
 */
export function readChangelogSection(markdown: string, version: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(line));
  if (start === -1) {
    throw new ConfigError(`CHANGELOG.md has no "## ${version}" section; write one before tagging ${version}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
