import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { RunSkill } from '@harness/runtime-api';
import { ConfigError } from '@harness/shared';

/** The YAML object between the first two `---` lines of a `SKILL.md`'s text. */
function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) throw new ConfigError('SKILL.md has no frontmatter between two `---` lines');
  return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`SKILL.md frontmatter is missing a "${field}" string`);
  }
  return value;
}

// src/domain -> src -> the package root. `skills/` sits beside `src/`, so it ships in the image
// (node.Dockerfile copies the whole `harness` tree) without being compiled.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The skills the kernel itself ships, as opposed to a pack's.
 *
 * Exactly one today: `knowledge-sync`, which the knowledge sync playbook names. It cannot live in
 * a pack — refreshing a knowledge base is not a product area's business, and a deployment that
 * loaded a different pack would lose it — and `preflightPlaybook` requires a playbook's skill to
 * be one the host offers, so the host has to offer it. A second one belongs here too; a third
 * probably means this directory wants its own reason for existing, written down.
 */
export function kernelSkillsDir(): string {
  return path.join(packageRoot, 'skills');
}

/**
 * Every skill's `SKILL.md`, read off the packs' own `skillsDir`s. Each directory is walked in
 * name order, so the catalogue a runtime sees is deterministic across a process's whole life,
 * not whatever order the filesystem happened to hand back. A skill's frontmatter `name` must
 * match its directory name — the one thing this reads that a pack's own tests do not already
 * check — because a mismatch would let a skill file move without moving the runtime handle
 * that names it, or let two skills collide silently on one activation name.
 */
export async function readSkillCatalogue(dirs: readonly string[]): Promise<RunSkill[]> {
  const skills: RunSkill[] = [];
  for (const dir of dirs) {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const entry of entries) {
      const skillDir = path.join(dir, entry);
      const text = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      const frontmatter = parseFrontmatter(text);
      const name = requireString(frontmatter.name, 'name');
      if (name !== entry) {
        throw new ConfigError(`skill "${name}" in directory "${entry}" must be named after its directory`);
      }
      const description = requireString(frontmatter.description, 'description');
      const version = requireString(frontmatter.version, 'version');
      skills.push({ name, version, description, dir: skillDir });
    }
  }
  return skills;
}
