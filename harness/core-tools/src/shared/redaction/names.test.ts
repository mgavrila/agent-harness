import { describe, it, expect } from 'vitest';
import { isRestrictedName } from './names.js';

describe('isRestrictedName', () => {
  it.each(['ssn', 'SSN', 'social_security_number', 'dea_number', 'tax_id', 'ein'])(
    'treats %s as restricted',
    (name) => {
      expect(isRestrictedName(name)).toBe(true);
    },
  );

  it.each(['npi', 'first_name', 'deadline'])('treats %s as unrestricted', (name) => {
    expect(isRestrictedName(name)).toBe(false);
  });

  // fieldNameFor in shared/redaction/text.ts generates exactly these names for a
  // second distinct value of a kind, so they are names this harness hands out.
  it.each(['ssn_2', 'ein_2', 'dea_number_2', 'SSN-3', 'dea_no_10'])(
    'treats the ordinal-suffixed name %s as restricted',
    (name) => {
      expect(isRestrictedName(name)).toBe(true);
    },
  );
});
