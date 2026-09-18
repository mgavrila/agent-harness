import { sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { modelCalls, withTransaction } from '@harness/db';
import { ConfigError, ToolError } from '@harness/shared';
import { openRun } from '../session/repository.js';
import type { ToolDeps } from '../tooling/types.js';
import { makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import { EMBED_BATCH, assertEmbedDims, embedTexts } from './embed.js';

const db = useTestDb();

type FakeGateway = Awaited<ReturnType<typeof startFakeGateway>>;

/** A run, a fake gateway, and deps wired to it at sixteen dimensions. */
async function onFakeGateway(): Promise<{ deps: ToolDeps; fake: FakeGateway }> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const context = await openRun(db, {
    client: 'test',
    principal: {
      id: 'u-test',
      kind: 'user',
      level: 'practitioner',
      displayName: 'Test user',
      surfaces: {},
      attributes: {},
    },
    threadId: null,
    surface: null,
    conversation: null,
  });
  const deps = makeTestDeps(db, {
    context,
    embedDims: 16,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
  });
  return { deps, fake };
}

describe('embedTexts', () => {
  it('asks the embed route for vectors at the configured width and keeps them in order', async () => {
    const { deps } = await onFakeGateway();
    const vectors = await embedTexts(deps, ['the office closes at five', 'escalate anything urgent']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(16);
    expect(vectors[1]).toHaveLength(16);
    expect(vectors[0]).not.toEqual(vectors[1]);
    // The same text, again, is the same vector: a re-sync of an unchanged document is stable.
    expect(await embedTexts(deps, ['the office closes at five'])).toEqual([vectors[0]]);
  });

  it('attributes the spend to the run, on the embed route', async () => {
    const { deps } = await onFakeGateway();
    await embedTexts(deps, ['one', 'two']);
    const rows = await db.select().from(modelCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: 'embed', model: 'embed', runId: deps.context.runId, outputTokens: 0 });
    expect(rows[0].inputTokens).toBeGreaterThan(0);
  });

  it('sends at most EMBED_BATCH texts per request', async () => {
    const { deps, fake } = await onFakeGateway();
    const texts = Array.from({ length: EMBED_BATCH + 3 }, (_, i) => `chunk number ${i}`);
    const vectors = await embedTexts(deps, texts);
    expect(vectors).toHaveLength(texts.length);
    expect(fake.embeddings.map((call) => call.input.length)).toEqual([EMBED_BATCH, 3]);
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const { deps, fake } = await onFakeGateway();
    fake.setEmbeddingResponder(() => ({ dimensions: 8 }));
    await expect(embedTexts(deps, ['one'])).rejects.toThrow(ToolError);
    await expect(embedTexts(deps, ['one'])).rejects.toThrow(
      'model route "embed" returned a 8-dimension vector; this deployment stores 16',
    );
  });

  it('refuses a short answer and a gateway failure, naming the route and never the body', async () => {
    const { deps, fake } = await onFakeGateway();
    fake.setEmbeddingResponder(() => ({ vectors: [Array.from({ length: 16 }, () => 0.1)] }));
    await expect(embedTexts(deps, ['one', 'two'])).rejects.toThrow('returned 1 vector(s) for 2 text(s)');
    fake.setEmbeddingResponder(() => ({ status: 429, errorBody: { error: { message: 'secret prompt echo' } } }));
    const failure = (await embedTexts(deps, ['one']).catch((err: unknown) => err as Error)) as Error;
    expect(failure.message).toBe(
      'model route "embed" is over its daily budget; raise it in clients/<name>/routing.yaml',
    );
    expect(failure.message).not.toContain('secret prompt echo');
  });

  it('embeds nothing for no texts, and makes no call', async () => {
    const { deps, fake } = await onFakeGateway();
    expect(await embedTexts(deps, [])).toEqual([]);
    expect(fake.embeddings).toEqual([]);
  });
});

describe('assertEmbedDims', () => {
  it('passes at the width the column was created with', async () => {
    await expect(assertEmbedDims(db, 1024)).resolves.toBeUndefined();
  });

  it('refuses any other width, naming both numbers and the variable', async () => {
    const failure = (await assertEmbedDims(db, 768).catch((err: unknown) => err as Error)) as Error;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      'HARNESS_EMBED_DIMS is 768 but knowledge_chunks.embedding stores 1024-dimension vectors; a deployment cannot change its embedding width in place',
    );
  });

  it('says what to run when the table is not there at all', async () => {
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS knowledge_probe'));
    try {
      // A search_path with no `public` makes `knowledge_chunks` unresolvable, which is what a
      // database that has not been migrated looks like to this check.
      //
      // `SET LOCAL`, inside a transaction, on that transaction's own connection — not a plain
      // `SET` on the pool. `createDb` hands out a `pg.Pool`, a `SET` binds to whichever client
      // happened to serve it, and the next statement is free to land on a different one: the
      // assertion below would then run with `public` still on the path and pass for the wrong
      // reason. Inside a transaction there is one client by construction, and `SET LOCAL` is
      // undone by the rollback, so nothing has to be put back afterwards either.
      await expect(
        withTransaction(db, async (tx) => {
          await tx.execute(sql.raw('SET LOCAL search_path TO knowledge_probe'));
          await assertEmbedDims(tx, 1024);
        }),
      ).rejects.toThrow('knowledge_chunks does not exist; run pnpm db:migrate before starting');
    } finally {
      await db.execute(sql.raw('DROP SCHEMA IF EXISTS knowledge_probe CASCADE'));
    }
  });
});
