import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { LEVELS, optionalEnv, type Level } from '@harness/shared';
import {
  ACTION_CLASSES,
  BEHAVIORS,
  type ActionClass,
  type Behavior,
  type ClassTable,
  type LevelOverrides,
  type Policy,
  type PolicyOverrides,
} from '@harness/pack-api';

export {
  ACTION_CLASSES,
  BEHAVIORS,
  type ActionClass,
  type Behavior,
  type ClassTable,
  type LevelOverrides,
  type Policy,
  type PolicyOverrides,
};

/**
 * The kernel's matrix, before a client's `policy.yaml` says otherwise. It encodes spec 4.4's
 * table as the practitioner row in `classes` plus the cells where another level differs:
 *
 *   class            member    practitioner  lead      admin     service
 *   read             auto      auto          auto      auto      auto
 *   write.self       auto      auto          auto      auto      auto
 *   write.internal   approval  auto          auto      auto      auto
 *   write.assign     approval  auto          auto      auto      approval
 *   external         approval  approval      approval  approval  approval
 *   financial        blocked   blocked       approval  approval  blocked
 *   destructive      blocked   approval      approval  approval  blocked
 *   admin            blocked   blocked       blocked   auto      blocked
 *
 * The practitioner row is exactly the flat table the kernel shipped before levels existed, which
 * is why the test principal is a practitioner and no existing test moved.
 */
export const DEFAULT_POLICY: Policy = {
  classes: {
    read: 'auto',
    'write.self': 'auto',
    'write.internal': 'auto',
    'write.assign': 'auto',
    external: 'approval',
    financial: 'blocked',
    destructive: 'approval',
    admin: 'blocked',
  },
  levels: {
    member: { 'write.internal': 'approval', 'write.assign': 'approval', destructive: 'blocked' },
    lead: { financial: 'approval' },
    admin: { financial: 'approval', admin: 'auto' },
    service: { 'write.assign': 'approval', destructive: 'blocked' },
  },
};

const OverridesShape = z.partialRecord(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS));

const PolicyFile = z.object({
  classes: OverridesShape.optional(),
  levels: z.partialRecord(z.enum(LEVELS), OverridesShape).optional(),
});

/**
 * `overrides` on top of `base`: class by class, then level by level and class by class. Neither
 * input is mutated. A level override the base ships survives an override to `classes`, because
 * `decide` reads the level cell first — a client that wants a member treated like everyone else
 * says so under `levels.member`.
 */
export function mergePolicy(base: Policy, overrides: PolicyOverrides): Policy {
  const levels: LevelOverrides = {};
  for (const level of LEVELS) {
    const merged = { ...base.levels[level], ...overrides.levels?.[level] };
    if (Object.keys(merged).length > 0) levels[level] = merged;
  }
  return { classes: { ...base.classes, ...overrides.classes } as ClassTable, levels };
}

function firstUnknown(keys: string[], allowed: readonly string[]): string | undefined {
  return keys.find((k) => !allowed.includes(k));
}

/**
 * Parse a client's `policy.yaml` and merge it over the defaults. A bad file is named in the words
 * the person editing it used: the class, the behaviour or the level that is not one of ours.
 */
export function parsePolicy(yamlText: string): Policy {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = PolicyFile.safeParse(raw);
  if (!parsed.success) {
    const file = raw as { classes?: Record<string, unknown>; levels?: Record<string, Record<string, unknown> | null> };
    const badLevel = firstUnknown(Object.keys(file.levels ?? {}), LEVELS);
    if (badLevel) throw new Error(`policy: unknown level "${badLevel}"`);
    const tables: [string, Record<string, unknown>][] = [
      ['classes', file.classes ?? {}],
      ...Object.entries(file.levels ?? {}).map(
        ([level, table]) => [`levels.${level}`, table ?? {}] as [string, Record<string, unknown>],
      ),
    ];
    for (const [where, table] of tables) {
      const badKey = firstUnknown(Object.keys(table), ACTION_CLASSES);
      if (badKey) throw new Error(`policy: unknown action class "${badKey}" in ${where}`);
      const badVal = Object.values(table).find((v) => !(BEHAVIORS as readonly string[]).includes(String(v)));
      if (badVal !== undefined) throw new Error(`policy: invalid behavior "${String(badVal)}" in ${where}`);
    }
    throw new Error(`policy: ${z.prettifyError(parsed.error)}`);
  }
  return mergePolicy(DEFAULT_POLICY, parsed.data);
}

export async function loadPolicy(filePath: string | undefined = optionalEnv('HARNESS_POLICY_FILE')): Promise<Policy> {
  if (!filePath) return mergePolicy(DEFAULT_POLICY, {});
  const text = await readFile(filePath, 'utf8');
  return parsePolicy(text);
}

/** The level's own cell when it has one, else the class default. */
export function decide(actionClass: ActionClass, level: Level, policy: Policy): Behavior {
  return policy.levels[level]?.[actionClass] ?? policy.classes[actionClass];
}
