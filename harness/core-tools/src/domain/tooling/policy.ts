import { LEVELS, type Level } from '@harness/shared';
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
 * The kernel's matrix, before a client document's `policy` section says otherwise. It encodes
 * spec 4.4's table as the practitioner row in `classes` plus the cells where another level
 * differs:
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

/**
 * `overrides` on top of `base`: class by class, then level by level and class by class. Neither
 * input is mutated. A level override the base ships survives an override to `classes`, because
 * `decide` reads the level cell first — a client that wants a member treated like everyone else
 * says so under `levels.member`.
 *
 * The overrides come from the client document's `policy` section, which `@harness/config-api`
 * validated; nothing reads a policy file any more.
 */
export function mergePolicy(base: Policy, overrides: PolicyOverrides): Policy {
  const levels: LevelOverrides = {};
  for (const level of LEVELS) {
    const merged = { ...base.levels[level], ...overrides.levels?.[level] };
    if (Object.keys(merged).length > 0) levels[level] = merged;
  }
  return { classes: { ...base.classes, ...overrides.classes } as ClassTable, levels };
}

/** The level's own cell when it has one, else the class default. */
export function decide(actionClass: ActionClass, level: Level, policy: Policy): Behavior {
  return policy.levels[level]?.[actionClass] ?? policy.classes[actionClass];
}
