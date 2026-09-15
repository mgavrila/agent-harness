import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { ALL_TOOLS } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '../../../packs/healthcare/skills');

/**
 * Every tool a skill may name. This used to carry an allowlist for the
 * `documents_*` and `verify_nppes` names, which a skill declared while the
 * document-ingestion plan was still on its own branch; that plan has landed,
 * so those names are in `ALL_TOOLS` like any other and the escape hatch is
 * gone. A skill naming a tool this server does not register is now a typo.
 */
const KNOWN_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

const REQUIRED_HARNESS_KEYS = ['owner', 'eval_status', 'evals', 'action_classes', 'tools'] as const;

function readFrontmatter(name: string): Record<string, unknown> {
  const text = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${name}: SKILL.md has no frontmatter block`);
  return parse(match[1]) as Record<string, unknown>;
}

describe('healthcare pack skill frontmatter', () => {
  // Directories only: a stray file beside the skills is not a skill.
  const skillNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it('discovers the four credentialing skills', () => {
    expect(skillNames.sort()).toEqual([
      'credentialing-expirations',
      'credentialing-fill-form',
      'credentialing-intake',
      'credentialing-roster',
    ]);
  });

  it.each(skillNames)('%s has valid frontmatter', (name) => {
    const fm = readFrontmatter(name);
    expect(fm.name).toBe(name);
    for (const key of ['description', 'version']) {
      expect(fm[key], `${name}: missing ${key}`).toBeTruthy();
    }

    const harness = (fm.metadata as Record<string, unknown> | undefined)?.harness as Record<string, unknown> | undefined;
    expect(harness, `${name}: missing metadata.harness`).toBeTruthy();
    for (const key of REQUIRED_HARNESS_KEYS) {
      expect(harness?.[key], `${name}: missing metadata.harness.${key}`).not.toBeUndefined();
    }

    const tools = harness?.tools as string[];
    expect(Array.isArray(tools), `${name}: metadata.harness.tools must be an array`).toBe(true);
    expect(tools, `${name}: must call harness_set_context first`).toContain('harness_set_context');

    for (const tool of tools) {
      expect(KNOWN_TOOL_NAMES.has(tool), `${name}: unknown tool "${tool}"`).toBe(true);
    }
  });
});
