import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { PRINCIPAL_ID_PATTERN, parseIdentityFile } from './principals.js';

const manager = {
  id: 'u-practice-manager',
  kind: 'user',
  level: 'admin',
  displayName: 'Practice manager',
  surfaces: { memory: 'U0123ABCD' },
};
const nightly = { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' };

describe('PRINCIPAL_ID_PATTERN', () => {
  it('accepts a prefixed lowercase slug and refuses anything else', () => {
    for (const id of ['u-practice-manager', 'svc-local', 'u-a1']) expect(PRINCIPAL_ID_PATTERN.test(id), id).toBe(true);
    for (const id of ['practice-manager', 'U-Manager', 'u-', 'svc--x', 'u-with space']) {
      expect(PRINCIPAL_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});

describe('parseIdentityFile', () => {
  it('fills the two defaults, so a principal with no surfaces and no attributes still parses', () => {
    const [svc] = parseIdentityFile({ principals: [nightly] });
    expect(svc).toEqual({ ...nightly, surfaces: {}, attributes: {} });
  });

  it('refuses an empty file, because a deployment with nobody in it can run nothing', () => {
    expect(() => parseIdentityFile({ principals: [] })).toThrow(ConfigError);
    expect(() => parseIdentityFile({})).toThrow(/identity file is invalid/);
  });

  it('refuses a duplicate id', () => {
    expect(() => parseIdentityFile({ principals: [manager, manager] })).toThrow(
      /"u-practice-manager" is declared twice/,
    );
  });

  it('ties the id prefix, the kind and the service level together', () => {
    expect(() => parseIdentityFile({ principals: [{ ...manager, id: 'svc-manager' }] })).toThrow(
      /"svc-manager" is a user and must have a "u-" id/,
    );
    expect(() => parseIdentityFile({ principals: [{ ...manager, level: 'service' }] })).toThrow(
      /"u-practice-manager" is a user and cannot be at level "service"/,
    );
    expect(() => parseIdentityFile({ principals: [{ ...nightly, level: 'admin' }] })).toThrow(
      /"svc-playbooks" is a service and must be at level "service"/,
    );
  });

  it('refuses two principals sharing one surface user id, because resolve() could only guess', () => {
    const twin = { ...manager, id: 'u-coordinator', level: 'lead' };
    expect(() => parseIdentityFile({ principals: [manager, twin] })).toThrow(
      /"u-practice-manager" and "u-coordinator" both claim user "U0123ABCD" on surface "memory"/,
    );
  });

  it('refuses a surface name that is not a surface name', () => {
    expect(() => parseIdentityFile({ principals: [{ ...manager, surfaces: { Slack: 'U1' } }] })).toThrow(
      /identity file is invalid/,
    );
  });
});
