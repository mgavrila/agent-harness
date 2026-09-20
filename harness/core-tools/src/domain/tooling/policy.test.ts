import { describe, it, expect } from 'vitest';
import type { ActionClass, Behavior, Level } from '@harness/pack-api';
import { DEFAULT_POLICY, decide, mergePolicy } from './policy.js';

/** Spec 4.4's table, cell for cell. Rows are action classes, columns the five levels. */
const TABLE: Record<ActionClass, Record<Level, Behavior>> = {
  read: { member: 'auto', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.self': { member: 'auto', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.internal': { member: 'approval', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.assign': { member: 'approval', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'approval' },
  external: { member: 'approval', practitioner: 'approval', lead: 'approval', admin: 'approval', service: 'approval' },
  financial: { member: 'blocked', practitioner: 'blocked', lead: 'approval', admin: 'approval', service: 'blocked' },
  destructive: { member: 'blocked', practitioner: 'approval', lead: 'approval', admin: 'approval', service: 'blocked' },
  admin: { member: 'blocked', practitioner: 'blocked', lead: 'blocked', admin: 'auto', service: 'blocked' },
};

/**
 * The `policy.classes` table a deployment's client document carries, as a literal.
 *
 * `@harness/config-api` validates that section and `mergePolicy` is what applies it, so nothing
 * here reads a policy file or names a client folder. What is pinned below is the *merge*, against
 * the principal a scheduled playbook runs as.
 */
const DEPLOYMENT_CLASSES = {
  read: 'auto',
  'write.internal': 'auto',
  external: 'approval',
  financial: 'blocked',
  destructive: 'approval',
} as const;

describe('DEFAULT_POLICY', () => {
  for (const [cls, row] of Object.entries(TABLE) as [ActionClass, Record<Level, Behavior>][]) {
    for (const [level, behavior] of Object.entries(row) as [Level, Behavior][]) {
      it(`decides ${cls} for ${level} as ${behavior}`, () => {
        expect(decide(cls, level, DEFAULT_POLICY)).toBe(behavior);
      });
    }
  }

  it('keeps the practitioner column equal to the old flat table on the five old classes', () => {
    // Every existing kernel test runs as a practitioner (see TEST_PRINCIPAL), and this is why
    // none of them changed behaviour when the level arrived.
    expect(
      ['read', 'write.internal', 'external', 'financial', 'destructive'].map((c) =>
        decide(c as ActionClass, 'practitioner', DEFAULT_POLICY),
      ),
    ).toEqual(['auto', 'auto', 'approval', 'blocked', 'approval']);
  });
});

describe('mergePolicy', () => {
  it('replaces classes one by one and level entries one by one, leaving the rest', () => {
    const merged = mergePolicy(DEFAULT_POLICY, {
      classes: { external: 'auto' },
      levels: { member: { external: 'blocked' } },
    });
    expect(decide('external', 'lead', merged)).toBe('auto');
    expect(decide('external', 'member', merged)).toBe('blocked');
    // A level override the kernel ships survives a client's classes block.
    expect(decide('write.internal', 'member', merged)).toBe('approval');
    expect(decide('financial', 'lead', merged)).toBe('approval');
  });

  it('merges a levels block per level and per class', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { levels: { member: { external: 'auto' } } });
    expect(decide('external', 'member', merged)).toBe('auto');
    expect(decide('external', 'practitioner', merged)).toBe('approval');
    expect(decide('write.internal', 'member', merged)).toBe('approval');
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    mergePolicy(DEFAULT_POLICY, { classes: { read: 'blocked' }, levels: { admin: { read: 'blocked' } } });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

/**
 * A deployment's own policy section, against the principal its nightly playbook runs as.
 *
 * The `knowledge-sync` playbook calls one tool, `knowledge_sync`, as `svc-playbooks`, which the
 * client document declares at `level: service`. Nothing before this asked whether policy would
 * let that call through: `preflightPlaybook` checks the skill, the principal and the surface,
 * never the class. When `knowledge_sync` was `admin` the answer was `blocked`, so the refresh was
 * refused every night with `deliver: none` and nobody heard about it.
 */
describe('a deployment policy section, against the principal a scheduled playbook runs as', () => {
  const policy = mergePolicy(DEFAULT_POLICY, { classes: { ...DEPLOYMENT_CLASSES } });

  it('lets a service principal run a write.internal tool unattended', () => {
    expect(decide('write.internal', 'service', policy)).toBe('auto');
  });

  it('keeps every class it names meaning what it meant for a lead', () => {
    for (const cls of Object.keys(DEPLOYMENT_CLASSES) as (keyof typeof DEPLOYMENT_CLASSES)[]) {
      expect(decide(cls, 'lead', policy)).toBe(TABLE[cls].lead);
    }
    // A classes block leaves the kernel's level overrides exactly where they were.
    expect(policy.levels).toEqual(DEFAULT_POLICY.levels);
  });

  it('still parks that class for a member and blocks admin for a service, which is why the class moved', () => {
    // The class-level `write.internal: auto` does not reach a member: `decide` reads the level
    // cell first, and `mergePolicy` keeps the default matrix's `member` override.
    expect(decide('write.internal', 'member', policy)).toBe('approval');
    // The reason `knowledge_sync` could not stay `admin`: no service principal can ever call one.
    expect(decide('admin', 'service', policy)).toBe('blocked');
  });
});
