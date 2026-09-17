import { describe, expect, it } from 'vitest';
import type { PackToolDeps } from '@harness/pack-api';
import { useTestDb, makeTestDeps } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';

const db = useTestDb();

describe('ToolDeps satisfies PackToolDeps', () => {
  it('assigns without a cast, which is what lets core hand a pack its real dependency bag', () => {
    const deps: ToolDeps = makeTestDeps(db);
    // A compile-time assertion with a runtime body, so a drift fails `pnpm -r typecheck` and a
    // missing member fails the suite. Widening ToolDeps is free; narrowing it, or renaming one
    // of these members, breaks every pack in the workspace and this is where it says so.
    const view: PackToolDeps = deps;
    expect(view.client).toBe('test');
    expect(view.principal).toMatchObject({ id: 'u-test', level: 'practitioner' });
    expect(view.kernel.MASKED).toBe('[restricted]');
    expect(view.kernel.isRestrictedName('ssn')).toBe(true);
    expect(view.kernelTools).toBeInstanceOf(Map);
    expect(view.packs.recordKinds().map((r) => r.kind)).toEqual(['provider']);
  });
});
