import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { CLIENT_DOCUMENT_VERSION, parseClientDocument, type ClientDocument } from './document.js';
import type { ConfigSource, LoadedDocument } from './types.js';

/**
 * A complete, valid client document, as a plain object, for a test or a conformance suite to
 * start from. `overrides` are shallow: pass a whole section, not a piece of one.
 *
 * It declares the memory surface and the run API, a scripted-runtime-shaped `runtime`, the
 * healthcare pack and one skill, because those are what the kernel's own suites need. It is NOT
 * the fixture client on disk — `clients/fixture/client.yaml` is, and Task 9 writes it.
 */
export function fixtureDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CLIENT_DOCUMENT_VERSION,
    id: 'fixture',
    displayName: 'Fixture',
    persona: 'You are the test assistant.',
    identity: {
      principals: [
        { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' } },
        { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' } },
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
        { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' },
      ],
    },
    policy: {},
    routing: {
      routes: {
        chat: { model: 'gemini/gemini-3-flash-preview' },
        extract: { model: 'gemini/gemini-3-flash-preview' },
        reason: { model: 'gemini/gemini-3-flash-preview' },
        judge: { model: 'groq/openai/gpt-oss-120b' },
        embed: { model: 'gemini/gemini-embedding-001' },
      },
    },
    playbooks: { playbooks: [] },
    skills: {},
    knowledge: { source: 'store' },
    surfaces: { memory: {}, http: {} },
    identityPlugin: { kind: 'static' },
    runtime: 'scripted',
    packs: ['@harness/pack-healthcare'],
    ...overrides,
  };
}

/** A source over documents already in hand: the one every kernel test drives. */
export class MemoryConfigSource implements ConfigSource {
  readonly name = 'memory';

  private readonly documents = new Map<string, LoadedDocument>();
  private readonly watchers = new Map<string, Set<(version: string) => void>>();
  closed = false;

  constructor(documents: readonly LoadedDocument[] = []) {
    for (const entry of documents) this.documents.set(entry.document.id, entry);
  }

  /** Make `document` the current version of its client, notifying every watcher of that client. */
  put(document: ClientDocument, version: string): void {
    this.documents.set(document.id, { document, version });
    for (const notify of this.watchers.get(document.id) ?? []) notify(version);
  }

  async load(clientId: string): Promise<LoadedDocument | null> {
    return this.documents.get(clientId) ?? null;
  }

  watch(clientId: string, onChange: (version: string) => void): () => void {
    const set = this.watchers.get(clientId) ?? new Set();
    set.add(onChange);
    this.watchers.set(clientId, set);
    return () => set.delete(onChange);
  }

  async list(): Promise<string[]> {
    return [...this.documents.keys()].sort();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** What a source implementation hands the conformance suite so it can drive it. */
export interface ConfigSourceHarness {
  source: ConfigSource;
  /**
   * Make `document` the current version of its client, and answer with **the version the source
   * will actually serve for it**.
   *
   * A source that takes caller-supplied versions returns `version` unchanged; one that derives its
   * own — `@harness/config-files` hashes the document's content — returns what it derived. The
   * conformance suite asserts the *property* a version has (it identifies a document, it is stable
   * while the content is, and it moves when the content does) rather than a literal string, which
   * no content-addressed source could satisfy.
   */
  put(document: ClientDocument, version: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * The suite every `ConfigSource` runs, so that "a source" is one thing rather than two.
 *
 * `makeSource` is called fresh for each case and its `close` is awaited afterwards, so a case
 * that fails does not leave a connection or a watcher behind for the next one.
 */
export function configSourceConformance(makeSource: () => Promise<ConfigSourceHarness>): void {
  const withSource = async (body: (harness: ConfigSourceHarness) => Promise<void>): Promise<void> => {
    const harness = await makeSource();
    try {
      await body(harness);
    } finally {
      await harness.close();
    }
  };

  describe('ConfigSource conformance', () => {
    it('answers null for a client it does not hold, rather than throwing', async () => {
      await withSource(async ({ source }) => {
        expect(await source.load('nobody')).toBeNull();
      });
    });

    it('answers a stored document with the version it assigned, and that same version twice', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        const document = parseClientDocument(fixtureDocument());
        const assigned = await harness.put(document, 'v1');
        const first = await source.load('fixture');
        expect(first?.document.id).toBe('fixture');
        expect(first?.version).toBe(assigned);
        // Stable: two loads of an unchanged document answer the same version.
        expect((await source.load('fixture'))?.version).toBe(assigned);
        // Stable under a re-write too: the same content is the same version.
        expect(await harness.put(document, 'v1')).toBe(assigned);
        expect((await source.load('fixture'))?.version).toBe(assigned);
      });
    });

    it('answers the new document and a different version once changed content is written', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        const before = await harness.put(parseClientDocument(fixtureDocument()), 'v1');
        const after = await harness.put(parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2');
        const loaded = await source.load('fixture');
        expect(loaded?.document.displayName).toBe('Renamed');
        expect(loaded?.version).toBe(after);
        // A version identifies a document, so changed content is a changed version — whether the
        // source was handed one or derived it from the content itself.
        expect(after).not.toBe(before);
      });
    });

    it('keeps two clients apart', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        await harness.put(parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'Alpha' })), 'v1');
        await harness.put(parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'Beta' })), 'v1');
        expect((await source.load('alpha'))?.document.displayName).toBe('Alpha');
        expect((await source.load('beta'))?.document.displayName).toBe('Beta');
      });
    });

    it('lists what it holds, sorted, when it can list at all', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        if (!source.list) return;
        await harness.put(parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'Beta' })), 'v1');
        await harness.put(parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'Alpha' })), 'v1');
        expect(await source.list()).toEqual(['alpha', 'beta']);
      });
    });

    it('refuses a document that is not one, naming the section', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        await expect(
          harness
            .put(fixtureDocument({ runtime: 'Not A Plug-in' }) as unknown as ClientDocument, 'v1')
            .then(() => source.load('fixture')),
        ).rejects.toThrow(ConfigError);
      });
    });
  });
}
