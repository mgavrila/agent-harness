import { describe, expect, it } from 'vitest';
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from './chunk.js';

/** A paragraph of `words` words, each `Word-<n>`, so a chunk boundary is visible in the text. */
const paragraph = (from: number, words: number): string =>
  Array.from({ length: words }, (_, i) => `word-${from + i}`).join(' ');

describe('chunkText', () => {
  it('leaves a short document whole, and an empty one with no chunks', () => {
    expect(chunkText('the office closes at five')).toEqual(['the office closes at five']);
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(chunkText('')).toEqual([]);
  });

  it('splits a long document into chunks no larger than size + overlap', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i * 60, 60)).join('\n\n');
    expect(text.length).toBeGreaterThan(4 * CHUNK_SIZE);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE + CHUNK_OVERLAP);
    // Nothing is lost: every word of the document is somewhere.
    const seen = new Set(chunks.flatMap((c) => c.split(/\s+/)));
    for (const word of text.split(/\s+/)) expect(seen.has(word), word).toBe(true);
  });

  it('overlaps consecutive chunks, and never starts one mid-word', () => {
    const text = Array.from({ length: 8 }, (_, i) => paragraph(i * 40, 40)).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const head = chunks[i].split(/\s+/)[0];
      // A whole token, not a fragment of one: the overlap is cut at a space.
      expect(head, `chunk ${i}`).toMatch(/^word-\d+$/);
      // And it really is a tail of the chunk before it.
      expect(chunks[i - 1].includes(head), `chunk ${i} overlaps ${i - 1}`).toBe(true);
    }
  });

  it('falls through the separators: paragraphs, then lines, then sentences, then words, then characters', () => {
    // No blank line and no newline anywhere: it still has to split, on sentences.
    const sentences = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the document.`).join(' ');
    const bySentence = chunkText(sentences, { size: 200, overlap: 20 });
    expect(bySentence.length).toBeGreaterThan(3);
    for (const chunk of bySentence) expect(chunk.length).toBeLessThanOrEqual(220);

    // One word, longer than a chunk: the last separator is the empty string, so it splits by
    // character rather than emitting one chunk the embedder would refuse.
    const oneWord = 'x'.repeat(2_500);
    const byCharacter = chunkText(oneWord, { size: 1_000, overlap: 0 });
    expect(byCharacter.length).toBe(3);
    expect(byCharacter.join('')).toBe(oneWord);
  });

  it('keeps the order of the document', () => {
    const text = Array.from({ length: 10 }, (_, i) => paragraph(i * 50, 50)).join('\n\n');
    const chunks = chunkText(text);
    const firstWordIndex = chunks.map((c) => Number(/word-(\d+)/.exec(c)![1]));
    expect([...firstWordIndex].sort((a, b) => a - b)).toEqual(firstWordIndex);
  });
});
