import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import type { Db } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { registryOf } from '../domain/packs/registry.js';
import { makeTestDeps } from '../testing.js';
import { publishedTools } from './catalog.js';

const packs = registryOf([healthcarePack]);

/**
 * Every tool a skill may name: the **published** catalogue, the list an MCP client receives.
 *
 * It used to be `allTools(packs)`, the kernel's own definitions. Those two were the same list
 * until the kernel became pack-agnostic; they are not any more. The kernel defines `records_*`
 * and the healthcare pack publishes `providers_*` over them, so a skill checked against the
 * kernel list would fail on every name it can actually call, and a skill naming a kernel tool
 * the loaded packs replaced would wrongly pass. `publishedTools` is the same function
 * `createCoreToolsServer` registers from, so this set is exactly what the server serves.
 *
 * The null database is safe and deliberate: `publishedTools` builds and filters definitions and
 * never calls a handler, so this test needs no Postgres — the same trick `app/record-surface.ts`
 * uses to record the surface offline.
 */
function publishedNames(registry: typeof packs): Set<string> {
  const deps = makeTestDeps(null as unknown as Db, { packs: registry });
  return new Set(publishedTools(deps).map((t) => t.name));
}

const KNOWN_TOOL_NAMES = publishedNames(packs);

const REQUIRED_HARNESS_KEYS = ['owner', 'eval_status', 'evals', 'action_classes', 'tools'] as const;

/** Every skill directory of every loaded pack, as `[skillsDir, skillName]` pairs. */
function skillsOf(dirs: string[]): [string, string][] {
  return dirs.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      // Directories only: a stray file beside the skills is not a skill.
      .filter((e) => e.isDirectory())
      .map((e) => [dir, e.name] as [string, string]),
  );
}

function readFrontmatter(dir: string, name: string): Record<string, unknown> {
  const text = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${name}: SKILL.md has no frontmatter block`);
  return parse(match[1]) as Record<string, unknown>;
}

describe('loaded pack skill frontmatter', () => {
  const skills = skillsOf(packs.skillsDirs());

  it('discovers the four credentialing skills', () => {
    expect(skills.map(([, name]) => name).sort()).toEqual([
      'credentialing-expirations',
      'credentialing-fill-form',
      'credentialing-intake',
      'credentialing-roster',
    ]);
  });

  it.each(skills)('%s/%s has valid frontmatter', (dir, name) => {
    const fm = readFrontmatter(dir, name);
    expect(fm.name).toBe(name);
    for (const key of ['description', 'version']) {
      expect(fm[key], `${name}: missing ${key}`).toBeTruthy();
    }

    const harness = (fm.metadata as Record<string, unknown> | undefined)?.harness as
      Record<string, unknown> | undefined;
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
