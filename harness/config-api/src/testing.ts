import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { CLIENT_DOCUMENT_VERSION, parseClientDocument, type ClientDocument } from './document.js';
import { envSecretValue } from './secrets.js';
import type { ConfigSource, LoadedDocument, SecretSource } from './types.js';

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
  /** Every version this source has been handed, so a rewrite can be refused the way a store does. */
  private readonly versions = new Map<string, ClientDocument>();
  private readonly watchers = new Map<string, Set<(version: string) => void>>();
  closed = false;

  constructor(documents: readonly LoadedDocument[] = []) {
    for (const entry of documents) this.documents.set(entry.document.id, entry);
  }

  /** Make `document` the current version of its client, notifying every watcher of that client. */
  put(document: ClientDocument, version: string): void {
    const key = `${document.id}:${version}`;
    const stored = this.versions.get(key);
    // The same rule the postgres writer enforces and the platform's control plane is bound by: a
    // version string identifies one document (spec section 6, rule 3). It is here as well as
    // there because the conformance suite is what makes "a source" one thing rather than two.
    if (stored && JSON.stringify(stored) !== JSON.stringify(document)) {
      throw new ConfigError(
        `client "${document.id}": version "${version}" is already stored with different content; a version string identifies one document, so write a new version rather than rewriting this one`,
      );
    }
    this.versions.set(key, document);
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

/**
 * A fresh harness per case, closed whether the case passed or not.
 *
 * Both conformance suites are built this way: a case that fails must not leave a connection, a
 * watcher or a pool behind for the next one, and a `finally` in one suite and not the other is
 * exactly the difference that goes unnoticed until a suite starts hanging.
 */
function eachCase<T extends { close(): Promise<void> }>(
  makeSource: () => Promise<T>,
): (body: (harness: T) => Promise<void>) => Promise<void> {
  return async (body) => {
    const harness = await makeSource();
    try {
      await body(harness);
    } finally {
      await harness.close();
    }
  };
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
  const withSource = eachCase(makeSource);

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

    it('refuses a version string written a second time with different content', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        const assigned = await harness.put(parseClientDocument(fixtureDocument()), 'v1');
        // A source that derives its own version from the content cannot express this case at all:
        // different content *is* a different version there, so there is nothing to collide. Same
        // shape as the `list` skip above.
        if (assigned !== 'v1') return;
        await expect(
          harness.put(parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1'),
        ).rejects.toThrow(ConfigError);
        // And the document it was serving is the one it still serves: a refused write changes
        // nothing, which is what makes a history readable after one.
        const loaded = await source.load('fixture');
        expect(loaded?.document.displayName).toBe('Fixture');
        expect(loaded?.version).toBe(assigned);
      });
    });
  });
}

/**
 * The variable every secret-source harness sets, so the suite can prove the `{ env }` path
 * without guessing a name a particular implementation happens to know.
 *
 * A plain constant rather than a `requiredEnv` call, deliberately: the environment scan in
 * `record-surface.ts` reads helper call sites, and a literal here would put a name in
 * `.env.example` that no deployment sets.
 */
export const CONFORMANCE_SECRET_VARIABLE = 'HARNESS_CONFORMANCE_SECRET';
export const CONFORMANCE_SECRET_VALUE = 'conformance-environment-value';

/** A store over secrets already in hand: the one every kernel test drives. */
export class MemorySecretSource implements SecretSource {
  readonly name = 'memory';
  closed = false;

  private readonly values = new Map<string, string>();
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    env: Readonly<Record<string, string | undefined>> = { [CONFORMANCE_SECRET_VARIABLE]: CONFORMANCE_SECRET_VALUE },
  ) {
    this.env = env;
  }

  /** Store one tenant's secret. The key is the pair, which is the isolation. */
  put(clientId: string, name: string, value: string): void {
    this.values.set(`${clientId}:${name}`, value);
  }

  async resolve(clientId: string, ref: { env: string } | { ref: string }): Promise<string> {
    if ('env' in ref) return envSecretValue(this.env, ref.env);
    const value = this.values.get(`${clientId}:${ref.ref}`);
    if (value === undefined) throw new ConfigError('this source holds no such secret for that client');
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** What a secret-source implementation hands the conformance suite so it can drive it. */
export interface SecretSourceHarness {
  source: SecretSource;
  /**
   * Store a secret, for a source that has a store.
   *
   * **Absent for a source that has only the environment**, which is how the suite tells the two
   * apart: the same shape `configSourceConformance` uses for `list`. A source with no `put` is
   * asserted to refuse every `{ ref }`; one with a `put` is asserted to resolve its own tenant's
   * and no other's.
   */
  put?(clientId: string, name: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The suite every `SecretSource` runs, so that "a source" is one thing rather than two.
 *
 * `makeSource` is called fresh for each case and its `close` is awaited afterwards, so a case
 * that fails does not leave a connection behind for the next one. The harness's source must
 * resolve `CONFORMANCE_SECRET_VARIABLE` from whatever environment it was built over.
 */
export function secretSourceConformance(makeSource: () => Promise<SecretSourceHarness>): void {
  const withSource = eachCase(makeSource);

  describe('SecretSource conformance', () => {
    it('is named in lowercase, which is what HARNESS_SECRET_SOURCE matches', async () => {
      await withSource(async ({ source }) => {
        expect(source.name).toMatch(/^[a-z][a-z0-9-]*$/);
      });
    });

    it('resolves an environment reference, whichever source it is', async () => {
      await withSource(async ({ source }) => {
        expect(await source.resolve('alpha', { env: CONFORMANCE_SECRET_VARIABLE })).toBe(CONFORMANCE_SECRET_VALUE);
      });
    });

    it('refuses an environment reference this deployment does not set', async () => {
      await withSource(async ({ source }) => {
        await expect(source.resolve('alpha', { env: 'HARNESS_CONFORMANCE_UNSET' })).rejects.toThrow(ConfigError);
      });
    });

    it('refuses a store reference it does not hold, without naming the row or the store', async () => {
      await withSource(async ({ source }) => {
        // Cast rather than `err as Error` inside the catch: `resolve` answers a value, so the
        // union a bare catch produces is `string | Error` and the assertions below would not
        // typecheck. A source that resolved here fails the `instanceof` on the next line.
        const failure = (await source.resolve('alpha', { ref: 'nobody' }).catch((err: unknown) => err)) as Error;
        expect(failure).toBeInstanceOf(ConfigError);
        // The message is a clause about the reference. The client, the surface and the field are
        // the caller's to add (`resolveSecrets`), and the value is nobody's to repeat.
        expect(failure.message).not.toContain('alpha');
      });
    });

    it('keeps two tenants apart under one secret name, when it has a store at all', async () => {
      await withSource(async (harness) => {
        if (!harness.put) {
          // A source with only the environment refuses every store reference, which is the whole
          // of its behaviour on this path and is asserted above.
          return;
        }
        await harness.put('alpha', 'web-token', 'tok-alpha');
        await harness.put('beta', 'web-token', 'tok-beta');
        expect(await harness.source.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
        expect(await harness.source.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
        // And a tenant that stored nothing reaches neither (invariant 21).
        await expect(harness.source.resolve('gamma', { ref: 'web-token' })).rejects.toThrow(ConfigError);
      });
    });

    it('answers the value it was given back, byte for byte', async () => {
      await withSource(async (harness) => {
        if (!harness.put) return;
        // A bot token, a bearer and a key are all opaque bytes; a source that trimmed or
        // re-encoded one would break the secret it answers with, without failing anything.
        const value = '  xoxb-with spaces and ünicode \n';
        await harness.put('alpha', 'odd', value);
        expect(await harness.source.resolve('alpha', { ref: 'odd' })).toBe(value);
      });
    });
  });
}
