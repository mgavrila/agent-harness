import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import { resolveOutFile } from '../storage/file-store.js';
import { stageEffect } from '../effects/outbox.js';
import { assertNoRestrictedPattern } from '../../shared/redaction/patterns.js';

/**
 * The smallest upload limit among the surfaces the harness supports, and a 25 MB generated file
 * is a bug rather than a delivery.
 */
const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

/**
 * The prefix every release idempotency key has ever carried.
 *
 * **Legacy value, kept deliberately.** `forms_release` is a pack tool name and the kernel has no
 * business knowing it; the kernel's own word for what this does is a release. But the prefix is
 * one half of `toolEffects.idempotencyKey`, and rows already staged in a deployment's outbox are
 * keyed with it. Renaming it would not rename those: the same file released again would hash to
 * a key nothing matches, and the deduplication that makes a repeated release one delivery would
 * silently stop working across the upgrade. So the name is wrong and the value stays, and this
 * constant exists so the vocabulary rule can exempt exactly this one string by name rather than
 * the file or the folder around it.
 */
const RELEASE_KEY_PREFIX = 'forms_release:';

export interface StagedRelease {
  effect_id: string;
  staged: boolean;
  file_id: string;
  filename: string;
  bytes: number;
}

/**
 * Stage a generated file for delivery. Resolves the id inside the out tree, refuses anything
 * that is not a readable file or is over the size limit, and stages one effect keyed on the
 * content-addressed id, so releasing the same bytes twice is one delivery.
 *
 * The `new Error('not a file')` below is a control-flow sentinel inside its own try, never
 * thrown out of this function — which is why it lives here and not in `tools/`, where the
 * project rule forbids the shape outright.
 */
export async function stageRelease(
  deps: ToolDeps,
  args: { file_id: string; channel?: string; surface?: string },
): Promise<StagedRelease> {
  const { file_id, channel, surface } = args;
  // Before the file is resolved, so a refused release stages nothing at all. Why the addressing
  // arguments need this and not only the prose is on `assertNoRestrictedPattern`.
  assertNoRestrictedPattern(channel, 'conversation id');
  assertNoRestrictedPattern(surface, 'surface name');
  const absolute = await resolveOutFile(file_id, deps.storageDir);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    // No pack tool is named here: the kernel does not know which of a pack's tools produced
    // the file. A pack that wants to say so catches this and rethrows — `forms_release` does.
    throw new ToolError(`no generated file with id "${file_id}"`);
  }
  if (size > MAX_RELEASE_BYTES) {
    throw new ToolError(`file "${file_id}" is ${size} bytes, over the ${MAX_RELEASE_BYTES} byte release limit`);
  }
  const filename = path.basename(absolute);
  const staged = await stageEffect(deps, {
    sink: 'surface_file',
    // Keyed on the file id, which is content-addressed: releasing the same bytes twice is one
    // delivery, and re-filling after a correction produces a new id and therefore a new one.
    // The conversation and the surface are part of the key because the same file sent to two
    // places is two deliveries, not a duplicate.
    //
    // The surface is joined on with `|`, which `CONVERSATION_ID_PATTERN` does not admit, so no
    // conversation id can spell the separator and impersonate an addressed release: `@` would
    // have made `channel: 'C1@memory'` and `channel: 'C1', surface: 'memory'` the same key, and
    // the second delivery would have been silently dropped as a duplicate of the first. With no
    // surface named, nothing is appended and the key is byte-identical to the pre-surface one,
    // which is what keeps a release already in a live outbox deduplicating across the upgrade.
    idempotencyKey: `${RELEASE_KEY_PREFIX}${file_id}${channel ? `:${channel}` : ''}${surface ? `|${surface}` : ''}`,
    payload: { file_id, path: absolute, filename, conversation: channel ?? null, surface: surface ?? null },
    summary: `Release ${filename}`,
  });
  return { effect_id: staged.effect_id, staged: staged.staged, file_id, filename, bytes: size };
}
