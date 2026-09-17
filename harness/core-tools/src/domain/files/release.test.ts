import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { toolEffects } from '@harness/db';
import { makeTestDeps, useTestDb } from '../../testing.js';
import { outRoot } from '../storage/layout.js';
import type { ToolDeps } from '../tooling/types.js';
import { stageRelease } from './release.js';

const db = useTestDb();
const FILE_ID = 'roster/aetna-abc.csv';

async function depsWithOutFile(): Promise<ToolDeps> {
  const deps = makeTestDeps(db);
  const absolute = path.join(outRoot(deps.storageDir), FILE_ID);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
  return deps;
}

const keyOf = async (effectId: string): Promise<string> => {
  const row = await db.query.toolEffects.findFirst({ where: eq(toolEffects.id, effectId) });
  return row!.idempotencyKey;
};

describe('the release idempotency key', () => {
  it('is byte-identical to the pre-surface key when the caller addresses nothing', async () => {
    const deps = await depsWithOutFile();
    const staged = await stageRelease(deps, { file_id: FILE_ID });
    // The value a row already sitting in a deployment's outbox carries. Deduplication across the
    // upgrade is exactly this string not moving.
    expect(await keyOf(staged.effect_id)).toBe(`test:forms_release:${FILE_ID}`);
  });

  it('tells a conversation that spells the separator apart from a genuinely addressed surface', async () => {
    // `C1@memory` is a legal conversation id — `CONVERSATION_ID_PATTERN` admits `@` — so joining
    // the surface on with `@` made these two different deliveries collide on one key, and the
    // second was dropped as a duplicate of the first. The separator has to be a character no
    // conversation id can contain.
    const deps = await depsWithOutFile();
    const spelled = await stageRelease(deps, { file_id: FILE_ID, channel: 'C1@memory' });
    const addressed = await stageRelease(deps, { file_id: FILE_ID, channel: 'C1', surface: 'memory' });

    expect(spelled.staged).toBe(true);
    expect(addressed.staged).toBe(true);
    expect(addressed.effect_id).not.toBe(spelled.effect_id);
    expect(await keyOf(spelled.effect_id)).not.toBe(await keyOf(addressed.effect_id));
    expect(await keyOf(addressed.effect_id)).toBe(`test:forms_release:${FILE_ID}:C1|memory`);
  });

  it('still makes the same file to the same place one delivery', async () => {
    const deps = await depsWithOutFile();
    const first = await stageRelease(deps, { file_id: FILE_ID, channel: 'C1', surface: 'memory' });
    const again = await stageRelease(deps, { file_id: FILE_ID, channel: 'C1', surface: 'memory' });
    expect(first.staged).toBe(true);
    expect(again.staged).toBe(false);
    expect(again.effect_id).toBe(first.effect_id);
  });
});
