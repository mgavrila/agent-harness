import { describe, it, expect } from 'vitest';
import { namesMatch } from './names.js';

describe('namesMatch', () => {
  it('ignores case, punctuation, titles and suffixes', () => {
    expect(namesMatch('Dr. Ada Lovelace, MD', 'ADA LOVELACE')).toBe(true);
    expect(namesMatch('Jackelyn Rae Kelley', 'JACKELYN KELLEY')).toBe(true);
    expect(namesMatch('Lovelace, Ada', 'Ada Lovelace')).toBe(true);
  });

  it('does not match different people', () => {
    expect(namesMatch('Ada Lovelace', 'Grace Hopper')).toBe(false);
    expect(namesMatch('Ada Lovelace', 'Ada Byron')).toBe(false);
  });
});
