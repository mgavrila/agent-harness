import { describe, expect, it } from 'vitest';
import { nextRunAfter } from './schema.js';

describe('nextRunAfter', () => {
  it('is the first firing strictly after the given instant, in the given zone', () => {
    const from = new Date('2026-09-15T12:00:00Z');
    expect(nextRunAfter('0 7 * * *', 'America/New_York', from).toISOString()).toBe('2026-09-16T11:00:00.000Z');
    expect(nextRunAfter('0 7 * * *', 'UTC', from).toISOString()).toBe('2026-09-16T07:00:00.000Z');
    expect(nextRunAfter('*/30 * * * *', 'UTC', from).toISOString()).toBe('2026-09-15T12:30:00.000Z');
  });
});
