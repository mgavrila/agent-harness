import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { definePack, type Pack } from '@harness/pack-api';
import { registryOf } from '../domain/packs/registry.js';
import { connectTestClient, makeTestDeps, useTestDb } from '../testing.js';
import { createCoreToolsServer } from '../tools/catalog.js';

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
