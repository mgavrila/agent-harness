import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * Words that belong to one area of the product and must not appear in the kernel.
 *
 * Spec section 8. The kernel stores records and attachments; a provider, a credential, a licence
 * and an NPI are things the healthcare pack knows about. A word here in kernel source is either
 * a schema key an agent will read, an identifier the next reader will copy, or a comment that
 * teaches the wrong model — and all three end with a second pack needing a special case.
 *
 * `npi` is the one entry that is not a plain substring. Three letters that short turn up inside
 * ordinary English and ordinary identifiers — `openPipeline` contains them — so it matches only
 * where a letter does not sit on either side. An underscore still counts as a boundary, so
 * `record_npi` is caught and `openPipeline` is not.
 */
const FORBIDDEN =
  /provider|credential|licen[cs]e|(?<![A-Za-z])npi(?![A-Za-z])|nppes|malpractice|dea_number|payer|roster/i;

/**
 * Directories scanned, and what is left out of each.
 *
 * `*.test.ts` is excluded because a test names what it tests: the healthcare suites in
 * `app/pack-healthcare/` are full of these words on purpose. `shared/redaction/` is excluded
 * because `RESTRICTED_NAME_KEYS` is a list of identifier stems — `dea_number` is one of them —
 * and that list is a data-protection primitive the kernel keeps on purpose (spec section 6).
 *
 * **The allowlist is empty and must stay empty.** A word that has to appear belongs in a pack,
 * or the comment that carries it should say what the kernel actually means: a model *vendor*, a
 * *record*, a *file*. Adding an entry here is a decision to write down in ARCHITECTURE.md, not a
 * way to get a red suite green.
 */
const SCANNED = [
  { root: 'harness/core-tools/src', skip: [/\.test\.ts$/, /\/shared\/redaction\//] },
  { root: 'evals/src', skip: [/\.test\.ts$/, /\.test-helpers\.ts$/] },
];

/**
 * Lines exempted by name, with the reason. Empty, and the one candidate that was expected to be
 * here is worth recording: `RELEASE_KEY_PREFIX` in `domain/files/release.ts` is a legacy
 * idempotency prefix that cannot be renamed without breaking deduplication across an upgrade,
 * but its value is `forms_release:`, which carries none of the words above — so it needs no
 * exemption and the list stays empty.
 */
const ALLOWLIST: { file: string; contains: string; reason: string }[] = [];

async function sourceFiles(dir: string, skip: RegExp[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full, skip)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.filter((file) => !skip.some((pattern) => pattern.test(file.split(path.sep).join('/'))));
}

describe('the kernel names no area of the product', () => {
  for (const { root, skip } of SCANNED) {
    it(`finds no credentialing vocabulary in ${root}`, async () => {
      const hits: string[] = [];
      const files = await sourceFiles(path.join(repoRoot, root), skip);
      // A scan that reached nothing would pass silently, which is the one way this test can lie.
      expect(files.length).toBeGreaterThan(10);
      for (const file of files) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        const text = await readFile(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          const match = FORBIDDEN.exec(line);
          if (!match) return;
          const exempt = ALLOWLIST.some((a) => a.file === relative && line.includes(a.contains));
          if (!exempt) hits.push(`${relative}:${i + 1}: ${match[0]} — ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  it('keeps the allowlist empty, because every entry is a kernel that still knows about a pack', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it('catches the words it claims to, so an empty result means the rule ran', () => {
    // The regex itself, checked against what it is for. Without this, a typo that made FORBIDDEN
    // match nothing would turn the two scans above into a pair of assertions that always pass.
    for (const line of [
      'const providerId = 1;',
      '/** the credential this evidences */',
      'incoming/license.pdf',
      'a licence number',
      '// the NPI is ten digits',
      "const key = 'record_npi';",
      'VERIFY_NPPES_ENABLED',
      'malpractice carrier',
      "fields.name === 'dea_number'",
      'the payer roster',
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(true);
    }
    // And the two shapes it must not catch: an ordinary identifier that happens to contain the
    // three letters of `npi`, and a word the kernel legitimately uses.
    for (const line of ['await openPipeline(opts);', 'const record = await readRecord(deps, id);']) {
      expect(FORBIDDEN.test(line), line).toBe(false);
    }
  });
});
