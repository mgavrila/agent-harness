import { describe, expect, it } from 'vitest';
import { parseClientDocument } from './document.js';
import { MemoryConfigSource, configSourceConformance, fixtureDocument } from './testing.js';

configSourceConformance(async () => {
  const source = new MemoryConfigSource();
  return {
    source,
    put: async (document, version) => {
      source.put(parseClientDocument(document), version);
      // This source serves the version it was handed, so that is what it assigned.
      return version;
    },
    close: async () => {
      await source.close();
    },
  };
});

describe('MemoryConfigSource', () => {
  it('tells a watcher of that client, and only that client, about a new version', () => {
    const source = new MemoryConfigSource();
    const seen: string[] = [];
    const stop = source.watch('fixture', (version) => seen.push(version));
    source.put(parseClientDocument(fixtureDocument()), 'v1');
    source.put(parseClientDocument(fixtureDocument({ id: 'other', displayName: 'Other' })), 'v9');
    expect(seen).toEqual(['v1']);
    stop();
    source.put(parseClientDocument(fixtureDocument()), 'v2');
    expect(seen).toEqual(['v1']);
  });
});
