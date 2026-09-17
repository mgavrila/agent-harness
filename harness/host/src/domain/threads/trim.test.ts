import { describe, expect, it } from 'vitest';
import { trimHistory } from './trim.js';

const turn = (i: number, size = 10) => ({ role: 'user' as const, content: `${i}`.padEnd(size, 'x') });

describe('trimHistory', () => {
  it('keeps the newest turns under both the message and the character budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i));
    expect(trimHistory(turns, { maxMessages: 3, maxChars: 1000 }).map((t) => t.content[0])).toEqual(['7', '8', '9']);
    expect(trimHistory(turns, { maxMessages: 10, maxChars: 25 }).map((t) => t.content[0])).toEqual(['8', '9']);
  });

  it('never returns a single turn that is over the character budget', () => {
    expect(trimHistory([turn(1, 100)], { maxMessages: 10, maxChars: 50 })).toEqual([]);
  });
});
