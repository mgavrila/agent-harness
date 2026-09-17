import { describe, it, expect } from 'vitest';
import type { ActionClass, Behavior, Level } from '@harness/pack-api';
import { DEFAULT_POLICY, decide, loadPolicy, mergePolicy, parsePolicy } from './policy.js';

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

/** The demo client's file, verbatim. */
const DEMO_POLICY = `classes:
  read: auto
  write.internal: auto
  external: approval
  financial: blocked
  destructive: approval
`;

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

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    mergePolicy(DEFAULT_POLICY, { classes: { read: 'blocked' }, levels: { admin: { read: 'blocked' } } });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

describe('parsePolicy', () => {
  it('reads the demo file unchanged and keeps it meaning what it meant for a lead', () => {
    const p = parsePolicy(DEMO_POLICY);
    for (const cls of ['read', 'write.internal', 'external', 'financial', 'destructive'] as const) {
      expect(decide(cls, 'lead', p)).toBe(TABLE[cls].lead);
    }
    expect(p.levels).toEqual(DEFAULT_POLICY.levels);
  });

  it('merges a classes block over the defaults', () => {
    const p = parsePolicy('classes:\n  external: auto\n');
    expect(p.classes.external).toBe('auto');
    expect(p.classes.financial).toBe('blocked');
  });

  it('merges a levels block per level and per class', () => {
    const p = parsePolicy('levels:\n  member:\n    external: auto\n');
    expect(decide('external', 'member', p)).toBe('auto');
    expect(decide('external', 'practitioner', p)).toBe('approval');
    expect(decide('write.internal', 'member', p)).toBe('approval');
  });

  it('rejects unknown classes, behaviors and levels, naming them', () => {
    expect(() => parsePolicy('classes:\n  bogus: auto\n')).toThrow(/bogus/);
    expect(() => parsePolicy('classes:\n  read: maybe\n')).toThrow(/maybe/);
    expect(() => parsePolicy('levels:\n  boss:\n    read: auto\n')).toThrow(/unknown level "boss"/);
    expect(() => parsePolicy('levels:\n  lead:\n    bogus: auto\n')).toThrow(/bogus/);
  });

  it('loadPolicy returns defaults when no file is configured', async () => {
    const saved = process.env.HARNESS_POLICY_FILE;
    delete process.env.HARNESS_POLICY_FILE;
    expect(await loadPolicy()).toEqual(DEFAULT_POLICY);
    if (saved !== undefined) process.env.HARNESS_POLICY_FILE = saved;
  });
});
