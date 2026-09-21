import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextRunAfter } from './schema.js';

describe('nextRunAfter', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Four hours behind UTC in September. If `nextRunAfter` ever stopped passing `timezone:
    // 'UTC'` to croner explicitly, croner would fall back to the process's own zone and this
    // case would compute 07:00 America/New_York, not 07:00 UTC — four hours apart, so no
    // rounding could make the two expectations agree by accident.
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('is the first firing strictly after the given instant, evaluated in UTC regardless of the process zone', () => {
    const from = new Date('2026-09-15T12:00:00Z');
    expect(nextRunAfter('0 7 * * *', from).toISOString()).toBe('2026-09-16T07:00:00.000Z');
    expect(nextRunAfter('*/30 * * * *', from).toISOString()).toBe('2026-09-15T12:30:00.000Z');
  });
});
