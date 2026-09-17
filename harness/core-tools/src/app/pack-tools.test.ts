import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { definePack, type Pack } from '@harness/pack-api';
import { registryOf } from '../domain/packs/registry.js';
import { connectTestClient, makeTestDeps, useTestDb } from '../testing.js';
import { createCoreToolsServer, publishedTools } from '../tools/catalog.js';

const db = useTestDb();

/**
 * `Pack.tools` types its argument `PackToolDeps`, the structural view of `ToolDeps` a pack can
 * see without importing core-tools (see `pack-api/src/kernel.ts`) — so this tool's handler,
 * like any real pack's, takes no typed `deps` at all and this fixture widens the parameter to
 * `unknown` to record whatever arrives. `createCoreToolsServer` is documented to hand the callback core's actual
 * dependency bag — the same object every core tool's handler runs against, not the
 * `PackRegistry` that an earlier version of `catalog.ts` passed by mistake. This pack records
 * whatever it is given so the test can assert on it directly.
 */
function packRecordingItsDeps(record: (deps: unknown) => void): Pack {
  return definePack({
    ...healthcarePack,
    name: 'pack-tools-fixture',
    // No `replaces`: this fixture's `tools` returns one marker rather than the shipped pack's
    // catalogue, and publication rule 4 refuses a source that replaces a kernel name it does not
    // publish. What is under test here is the dependency bag, not the replacement rules.
    replaces: undefined,
    tools: (deps: unknown) => {
      record(deps);
      return [
        {
          name: 'pack_test_marker',
          description: 'A tool a pack contributes, for the test that checks the dependency bag it receives.',
          actionClass: 'read',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: () => Promise.resolve({ ok: true }),
        },
      ];
    },
  });
}

describe('createCoreToolsServer and pack-contributed tools', () => {
  it('hands a pack tools callback the same deps object it was itself given, and registers what it returns', async () => {
    let received: unknown;
    const pack = packRecordingItsDeps((deps) => {
      received = deps;
    });
    const deps = makeTestDeps(db, { packs: registryOf([pack]) });

    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();

    expect(received).toBe(deps);
    expect(tools.map((t) => t.name)).toContain('pack_test_marker');
  });
});

/** The shipped pack with one record kind renamed, so two of them can be loaded side by side. */
function renamedKind(name: string, kind: string, genericTools: boolean): Pack {
  return definePack({
    ...healthcarePack,
    name,
    records: healthcarePack.records.map((r) => ({ ...r, kind, genericTools })),
    extraction: {
      ...healthcarePack.extraction,
      document_kinds: [`${name}_notes`],
      targets: healthcarePack.extraction.targets.map((t) => ({
        ...t,
        record_kind: kind,
        document_kinds: [`${name}_notes`],
      })),
    },
    documentKinds: [`${name}_notes`],
    replaces: undefined,
    tools: undefined,
  });
}

describe('the genericTools gate', () => {
  const generic = ['records_upsert', 'records_get', 'records_search', 'records_confirm_field', 'records_list_pending'];

  it('publishes none of the five when every loaded record kind is served by a pack’s own tools', () => {
    // The shipped pack: `provider` declares `genericTools: false` and its own `providers_*`
    // renames take their place, which is what keeps the healthcare catalogue at 23 names.
    const names = publishedTools(makeTestDeps(db, { packs: registryOf([healthcarePack]) })).map((t) => t.name);
    for (const tool of generic) expect(names).not.toContain(tool);
  });

  it('publishes all five for a pack that ships no tools of its own', () => {
    const packs = registryOf([renamedKind('plain', 'plain_record', true)]);
    const names = publishedTools(makeTestDeps(db, { packs })).map((t) => t.name);
    for (const tool of generic) expect(names).toContain(tool);
  });

  it('publishes all five as soon as one loaded kind wants them, even beside a gated one', () => {
    // The dual-pack case, in miniature: the gate is "does any loaded kind want them", not "do
    // all of them". A pack loaded beside one that ships its own tools must still reach a record.
    const packs = registryOf([renamedKind('gated', 'gated_record', false), renamedKind('open', 'open_record', true)]);
    const names = publishedTools(makeTestDeps(db, { packs })).map((t) => t.name);
    for (const tool of generic) expect(names).toContain(tool);
  });
});
