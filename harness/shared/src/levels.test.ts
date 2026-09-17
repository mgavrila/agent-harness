import { describe, expect, it } from 'vitest';
import { LEVELS, USER_LEVELS } from './levels.js';

describe('LEVELS', () => {
  it('lists the four user levels lowest first, then the service level', () => {
    expect(LEVELS).toEqual(['member', 'practitioner', 'lead', 'admin', 'service']);
    expect(USER_LEVELS).toEqual(['member', 'practitioner', 'lead', 'admin']);
  });

  it('keeps service outside the user ladder', () => {
    expect((USER_LEVELS as readonly string[]).includes('service')).toBe(false);
  });
});
